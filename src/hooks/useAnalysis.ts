// src/hooks/useAnalysis.ts — the preview→upgrade run-state machine (PLAN.md §6).
//
// Two-tier flow: an instant librosa *preview* (caps key+chords), then — in "accurate" mode and
// only when a better engine is actually available — an *upgrade* to btc that swaps in the
// richer result (extended chords + chord-derived key). If the upgrade fails (btc not installed →
// exit 3), the preview is KEPT. One AbortController owns each user run; aborting walks engine.ts's
// SIGTERM→grace→SIGKILL ladder.
//
// The state transitions live in a PURE exported reducer (`analysisReducer`) so they can be
// unit-tested with no renderer. Every async result dispatches an action carrying the `runId`
// captured when the run started; the reducer drops actions from a superseded run, so a
// cancelled/restarted leg can never corrupt the live one. The imperative bits (AbortController,
// the monotonic runId, mount flags) live in refs.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import { EngineAbortError, EngineUnavailableError, runEngineInfo } from "../core/engine";
import type { RunEngineResult } from "../core/engine";
import { analyzeWithCache } from "../core/cache";
import { resolveEngine } from "../core/engineResolve";
import type { Analysis, EngineEvent, EngineInfo, EngineInfoResponse, EngineName, EngineStage } from "../core/types";

export type AnalysisMode = "fast" | "accurate";

export type AnalysisPhase =
  | "idle"
  | "running-preview"
  | "done-preview"
  | "running-upgrade"
  | "done-upgrade"
  | "cancelling"
  | "error";

export interface AnalysisError {
  detail: string;
  hint?: string;
}

export interface AnalysisState {
  phase: AnalysisPhase;
  file: string | null;
  /** Best-available result so far: the preview, or (after a swap) the upgrade. */
  analysis: Analysis | null;
  /** True when `analysis` is the librosa preview (not yet upgraded). */
  isPreview: boolean;
  /** Latest progress stage of the active leg, or null between/after legs. */
  stage: EngineStage | null;
  /** Set only when the preview leg itself failed (no result to show). */
  error: AnalysisError | null;
  /** A non-fatal note, e.g. "btc unavailable — showing librosa preview". */
  upgradeNote: string | null;
  /** Monotonic id of the active run; the reducer's stale-leg guard compares against this. */
  runId: number;
}

export const initialAnalysisState: AnalysisState = {
  phase: "idle",
  file: null,
  analysis: null,
  isPreview: false,
  stage: null,
  error: null,
  upgradeNote: null,
  runId: 0,
};

export type AnalysisAction =
  | { type: "ANALYZE_REQUESTED"; runId: number; file: string }
  | { type: "PROGRESS"; runId: number; stage: EngineStage }
  | { type: "PREVIEW_DONE"; runId: number; analysis: Analysis }
  | { type: "UPGRADE_STARTED"; runId: number }
  | { type: "UPGRADE_DONE"; runId: number; analysis: Analysis }
  | { type: "UPGRADE_FAILED"; runId: number; cause: "unavailable" | "engine_error"; detail?: string }
  | { type: "CANCEL_REQUESTED"; runId: number }
  | { type: "ABORTED"; runId: number }
  | { type: "ERROR"; runId: number; detail: string; hint?: string };

function isRunning(phase: AnalysisPhase): boolean {
  return phase === "running-preview" || phase === "running-upgrade";
}

function upgradeNoteFor(cause: "unavailable" | "engine_error", detail?: string): string {
  if (cause === "unavailable") return "btc unavailable — showing librosa preview";
  return detail
    ? `upgrade failed: ${detail} — showing librosa preview`
    : "upgrade failed — showing librosa preview";
}

/**
 * Pure transition function (see the v4 plan table). `ANALYZE_REQUESTED` is ALWAYS accepted and
 * establishes the run's id; every other action is dropped unless its runId matches the live run.
 * Any (action, phase) pair not explicitly handled is a state-preserving no-op — this covers a
 * resolve/fail landing after the user already hit cancel (phase === "cancelling").
 */
export function analysisReducer(state: AnalysisState, action: AnalysisAction): AnalysisState {
  if (action.type === "ANALYZE_REQUESTED") {
    return { ...initialAnalysisState, phase: "running-preview", file: action.file, runId: action.runId };
  }
  if (action.runId !== state.runId) return state; // stale leg

  switch (action.type) {
    case "PROGRESS":
      return isRunning(state.phase) ? { ...state, stage: action.stage } : state;

    case "PREVIEW_DONE":
      if (state.phase !== "running-preview") return state;
      return { ...state, phase: "done-preview", analysis: action.analysis, isPreview: true, stage: null };

    case "UPGRADE_STARTED":
      if (state.phase !== "done-preview") return state;
      return { ...state, phase: "running-upgrade", isPreview: true, stage: null };

    case "UPGRADE_DONE":
      if (state.phase !== "running-upgrade") return state;
      return { ...state, phase: "done-upgrade", analysis: action.analysis, isPreview: false, stage: null };

    case "UPGRADE_FAILED":
      if (state.phase !== "running-upgrade") return state;
      return {
        ...state,
        phase: "done-preview",
        isPreview: true,
        error: null,
        stage: null,
        upgradeNote: upgradeNoteFor(action.cause, action.detail),
      };

    case "CANCEL_REQUESTED":
      return isRunning(state.phase) ? { ...state, phase: "cancelling", stage: null } : state;

    case "ABORTED":
      // State-keyed (NOT phase-keyed): keep a preview if one exists, else fall back to idle.
      if (state.analysis === null) {
        return { ...initialAnalysisState, runId: state.runId, file: state.file };
      }
      return { ...state, phase: "done-preview", isPreview: true, stage: null };

    case "ERROR":
      if (state.phase !== "running-preview") return state; // the upgrade leg uses UPGRADE_FAILED
      return {
        ...state,
        phase: "error",
        analysis: null,
        isPreview: false,
        stage: null,
        error: action.hint === undefined ? { detail: action.detail } : { detail: action.detail, hint: action.hint },
      };

    default:
      return state;
  }
}

// ── engine driver seam ──────────────────────────────────────────────
// Injectable so tests can drive the machine without spawning Python (mirrors the `*Base`
// injection the CLI commands use). The default wraps the real engine; it deliberately does NOT
// apply commands.ts's gateMock — the TUI is always interactive, so showing mock data on screen
// is allowed (it is never piped, and the [MOCK] badge makes it explicit).

export interface DriverRunOpts {
  signal: AbortSignal;
  onEvent?: (e: EngineEvent) => void;
  /** Installed engine info for the cache staleness check (passed on the btc upgrade leg). */
  expectedEngine?: EngineInfo;
}

export interface EngineDriver {
  analyze(engine: EngineName, file: string, opts: DriverRunOpts): Promise<RunEngineResult>;
  engineInfo(engine: EngineName, opts: { signal: AbortSignal }): Promise<EngineInfoResponse>;
  isMock: boolean;
}

export function makeDefaultDriver(): EngineDriver {
  const r = resolveEngine();
  return {
    isMock: r.isMock,
    analyze: (engine, file, { signal, onEvent, expectedEngine }) =>
      analyzeWithCache(r.analyzeBase, engine, file, {
        isMock: r.isMock,
        signal,
        onEvent,
        expectedEngine,
      }),
    engineInfo: (engine, { signal }) =>
      runEngineInfo({ command: [...r.engineInfoBase, "--engine", engine], signal }),
  };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface UseAnalysis {
  state: AnalysisState;
  /** Start a run for `file`; defaults to the sticky `mode`. Cancels any in-flight run first. */
  analyze: (file: string, mode?: AnalysisMode) => void;
  cancel: () => void;
  isMock: boolean;
  /** Whether a better-than-preview engine (btc) is installed (probed once at mount). */
  upgradeAvailable: boolean;
  mode: AnalysisMode;
  setMode: (m: AnalysisMode) => void;
  toggleMode: () => void;
}

export function useAnalysis(injectedDriver?: EngineDriver): UseAnalysis {
  const driver = useMemo(() => injectedDriver ?? makeDefaultDriver(), [injectedDriver]);
  const [state, dispatch] = useReducer(analysisReducer, initialAnalysisState);
  const [upgradeAvailable, setUpgradeAvailable] = useState(false);
  const [mode, setMode] = useState<AnalysisMode>("accurate");

  const acRef = useRef<AbortController | null>(null);
  const runIdRef = useRef(0);
  const mountedRef = useRef(true);
  const probedRef = useRef(false);
  // The mount-probe's btc EngineInfoResponse, kept for the cache staleness check on the
  // upgrade leg (so a stale cached btc result is recomputed rather than served).
  const probedInfoRef = useRef<EngineInfoResponse | null>(null);

  // Probe upgrade availability ONCE (probedRef guards StrictMode's double-invoke so we never
  // spawn the probe twice). The probe is a cheap engine-info call that exits on its own, so we
  // don't abort it on unmount — we just guard the setState. In-flight ANALYSES, by contrast,
  // ARE aborted on unmount (below) since they can be long-running.
  useEffect(() => {
    mountedRef.current = true;
    if (!probedRef.current) {
      probedRef.current = true;
      const probeAc = new AbortController();
      driver
        .engineInfo("btc", { signal: probeAc.signal })
        .then((info) => {
          // Auto-upgrade to btc whenever it's installed — it's MIT, so there is no consent gate.
          if (info.name === "btc") probedInfoRef.current = info; // for the cache staleness check
          if (mountedRef.current) setUpgradeAvailable(info.name === "btc");
        })
        .catch(() => {
          /* unavailable / aborted — leave upgradeAvailable false */
        });
    }
    return () => {
      mountedRef.current = false;
      acRef.current?.abort();
    };
  }, [driver]);

  const analyze = useCallback(
    (file: string, runMode: AnalysisMode = mode) => {
      acRef.current?.abort(); // cancel-then-restart
      const id = ++runIdRef.current;
      const ac = new AbortController();
      acRef.current = ac;
      const signal = ac.signal;

      dispatch({ type: "ANALYZE_REQUESTED", runId: id, file });

      const onEvent = (e: EngineEvent) => {
        if (e.type === "progress") dispatch({ type: "PROGRESS", runId: id, stage: e.stage });
      };

      void (async () => {
        // ── preview leg (librosa) ──
        let preview: Analysis;
        try {
          const res = await driver.analyze("librosa", file, { signal, onEvent });
          if (res.kind === "error") {
            dispatch({ type: "ERROR", runId: id, detail: res.value.detail, hint: res.value.hint });
            return;
          }
          preview = res.value;
          dispatch({ type: "PREVIEW_DONE", runId: id, analysis: preview });
        } catch (e) {
          if (e instanceof EngineAbortError) dispatch({ type: "ABORTED", runId: id });
          else dispatch({ type: "ERROR", runId: id, detail: errMsg(e) });
          return;
        }

        // ── upgrade leg (btc), only when warranted ──
        if (runMode === "fast" || !upgradeAvailable || signal.aborted) return;
        dispatch({ type: "UPGRADE_STARTED", runId: id });
        try {
          const res = await driver.analyze("btc", file, {
            signal,
            onEvent,
            expectedEngine: probedInfoRef.current ?? undefined,
          });
          if (res.kind === "error") {
            dispatch({ type: "UPGRADE_FAILED", runId: id, cause: "engine_error", detail: res.value.detail });
            return;
          }
          dispatch({ type: "UPGRADE_DONE", runId: id, analysis: res.value });
        } catch (e) {
          if (e instanceof EngineAbortError) dispatch({ type: "ABORTED", runId: id });
          else if (e instanceof EngineUnavailableError)
            dispatch({ type: "UPGRADE_FAILED", runId: id, cause: "unavailable", detail: e.message });
          else dispatch({ type: "UPGRADE_FAILED", runId: id, cause: "engine_error", detail: errMsg(e) });
        }
      })();
    },
    [driver, mode, upgradeAvailable],
  );

  const cancel = useCallback(() => {
    // No-op in the reducer if nothing is running; always safe to call.
    dispatch({ type: "CANCEL_REQUESTED", runId: runIdRef.current });
    acRef.current?.abort();
  }, []);

  const toggleMode = useCallback(() => {
    setMode((m) => (m === "accurate" ? "fast" : "accurate"));
  }, []);

  return { state, analyze, cancel, isMock: driver.isMock, upgradeAvailable, mode, setMode, toggleMode };
}
