// src/core/engine.ts — the spawn+validate seam between the frontend and the Python sidecar.
//
// One run = one child process (array-form `Bun.spawn`, never `sh -c` — the file path is
// untrusted user input). Mirrors the cancel discipline of tempo/src/core/daemon.ts:
// SIGTERM → grace → SIGKILL. Per PLAN.md §4:
//   stdout : exactly one JSON document — an `Analysis` or `{ error: EngineError }`.
//            Buffered fully (capped, never truncated), then parsed + validated.
//   stderr : NDJSON, one event per line — streamed incrementally to `onEvent` so the UI
//            can show ordered progress stages live.
//   exit   : 0 ok · 2 bad input · 3 engine-unavailable (route to doctor) · 4 analysis/internal.
//
// This module is deliberately decoupled from engine resolution: it takes a fully-formed
// `command` array. `engineResolve.ts` (later) builds that array; tests inject the mock
// sidecar directly. A single internal AbortController fuses the caller's signal and the
// wall-clock timeout into the one place that triggers the kill ladder — the seam that
// useAnalysis.ts sits on top of ("one AbortController per run").

import { EXIT, ENGINE_STAGES } from "./types";
import type { Analysis, EngineError, EngineEvent, EngineStage } from "./types";
import { ContractError, parseEngineOutput } from "./validate";

const DEFAULT_TIMEOUT_MS = 120_000; // generous: madmom can take 20–60s on a full song
const DEFAULT_GRACE_MS = 3_000; // SIGTERM → SIGKILL window (matches tempo's daemon)
const DEFAULT_MAX_STDOUT_BYTES = 64 * 1024 * 1024; // safety valve; a real Analysis is tiny

export interface RunEngineOptions {
  /** Array-form argv, e.g. ["/…/.venv/bin/python", "analyze.py", "analyze", "--file", f, "--json"]. */
  command: string[];
  cwd?: string;
  /** Full child environment. Pass `{ ...process.env, … }` to extend rather than replace. */
  env?: Record<string, string | undefined>;
  /** Caller cancel; aborting it walks the SIGTERM→SIGKILL ladder. */
  signal?: AbortSignal;
  /** Wall-clock budget for the whole run. Default 120 000 ms. */
  timeoutMs?: number;
  /** Grace before SIGTERM escalates to SIGKILL. Default 3 000 ms. */
  graceMs?: number;
  /** Called for each well-formed NDJSON stderr event, in arrival order. */
  onEvent?: (event: EngineEvent) => void;
  /** Hard cap on buffered stdout; exceeding it errors (never silently truncates). */
  maxStdoutBytes?: number;
}

/**
 * A completed run. A well-formed `{ error }` envelope from the engine is a *result*, not a
 * thrown error — the engine ran and reported a structured failure (bad input / decode /
 * internal). Process-level failures (timeout, cancel, crash, unparseable output, an
 * unavailable engine) are *thrown* instead. This mirrors `parseEngineOutput`'s discriminator.
 */
export type RunEngineResult =
  | { kind: "analysis"; value: Analysis }
  | { kind: "error"; value: EngineError };

/** Base for process-level failures (as opposed to a structured `{ error }` engine result). */
export class EngineRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineRunError";
  }
}
/** Spawn/crash/protocol failure: empty argv, no output, killed by a foreign signal, cap exceeded. */
export class EngineSpawnError extends EngineRunError {
  constructor(message: string) {
    super(message);
    this.name = "EngineSpawnError";
  }
}
/** The wall-clock budget elapsed; the child was force-terminated. */
export class EngineTimeoutError extends EngineRunError {
  constructor(message: string) {
    super(message);
    this.name = "EngineTimeoutError";
  }
}
/** The caller's AbortSignal fired; the run was cancelled. */
export class EngineAbortError extends EngineRunError {
  constructor(message: string) {
    super(message);
    this.name = "EngineAbortError";
  }
}
/** Exit code 3: the engine could not run (not installed / not working). Route to `chord doctor`. */
export class EngineUnavailableError extends EngineRunError {
  constructor(message: string) {
    super(message);
    this.name = "EngineUnavailableError";
  }
}

type AbortReason = "external" | "timeout" | null;

/** Minimal structural guard so a malformed stderr line is logged-and-skipped, not trusted. */
function asEngineEvent(obj: unknown): EngineEvent | null {
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;
  if (o["type"] === "progress" && ENGINE_STAGES.includes(o["stage"] as EngineStage)) {
    const ev: EngineEvent = { type: "progress", stage: o["stage"] as EngineStage };
    if (typeof o["index"] === "number") ev.index = o["index"];
    if (typeof o["total"] === "number") ev.total = o["total"];
    return ev;
  }
  if (
    o["type"] === "log" &&
    (o["level"] === "info" || o["level"] === "warn" || o["level"] === "error") &&
    typeof o["msg"] === "string"
  ) {
    return { type: "log", level: o["level"], msg: o["msg"] };
  }
  return null;
}

function handleStderrLine(line: string, onEvent?: (e: EngineEvent) => void): void {
  const trimmed = line.trim();
  if (!trimmed || !onEvent) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    onEvent({ type: "log", level: "warn", msg: `unparseable stderr line: ${trimmed}` });
    return;
  }
  const ev = asEngineEvent(parsed);
  if (ev) onEvent(ev);
  else onEvent({ type: "log", level: "warn", msg: `unknown stderr event: ${trimmed}` });
}

/** Drain stderr incrementally, framing on "\n" and surfacing each line as it arrives. */
async function readStderr(
  stream: ReadableStream<Uint8Array>,
  onEvent?: (e: EngineEvent) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        handleStderrLine(buf.slice(0, nl), onEvent);
        buf = buf.slice(nl + 1);
      }
    }
    buf += decoder.decode(); // flush any multi-byte tail
    handleStderrLine(buf, onEvent); // a non-empty trailing fragment is still an event
  } finally {
    reader.releaseLock();
  }
}

/** Buffer stdout fully; throw (never truncate) past the cap, per PLAN.md §4. */
async function readStdoutCapped(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new EngineSpawnError(`engine stdout exceeded ${maxBytes} bytes (no truncation allowed)`);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function clip(s: string, n = 200): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/**
 * Spawn the sidecar, stream progress, and return the validated `Analysis` or structured
 * engine `{ error }`. Throws an `EngineRunError` subclass for process-level failures and
 * `ContractError` for malformed/unparseable output.
 */
export async function runEngine(opts: RunEngineOptions): Promise<RunEngineResult> {
  const { command, cwd, env, signal, onEvent } = opts;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  const maxStdoutBytes = opts.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;

  if (command.length === 0) throw new EngineSpawnError("runEngine: empty command");

  // One controller fuses caller-cancel and timeout; whichever fires first records why.
  // A holder object (rather than a bare `let`) keeps the union type at the comparisons
  // below: the assignments happen in async callbacks, which TS's flow analysis can't see —
  // but it does reset property narrowing after the `await`s, restoring the full type.
  const ac = new AbortController();
  const aborted: { reason: AbortReason } = { reason: null };
  const trigger = (r: Exclude<AbortReason, null>) => {
    if (aborted.reason === null) aborted.reason = r;
    if (!ac.signal.aborted) ac.abort();
  };

  const onExternalAbort = () => trigger("external");
  // A signal that's *already* aborted must abort `ac` too (not just record the reason),
  // so the post-spawn `if (ac.signal.aborted)` immediately walks the kill ladder rather
  // than letting the child run to completion/timeout first.
  if (signal?.aborted) trigger("external");
  else signal?.addEventListener("abort", onExternalAbort, { once: true });

  const timer = setTimeout(() => trigger("timeout"), timeoutMs);

  const proc = Bun.spawn(command, {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  // The kill ladder: SIGTERM, then SIGKILL if the child outlives the grace window.
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = () => {
    try {
      proc.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    killTimer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, graceMs);
  };
  if (ac.signal.aborted) onAbort();
  else ac.signal.addEventListener("abort", onAbort, { once: true });

  let stdoutText: string;
  let code: number | null;
  try {
    [stdoutText] = await Promise.all([
      readStdoutCapped(proc.stdout, maxStdoutBytes),
      readStderr(proc.stderr, onEvent),
    ]);
    code = await proc.exited;
  } finally {
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    signal?.removeEventListener("abort", onExternalAbort);
    // Belt-and-suspenders: never leave an orphan, whatever path we exit by.
    if (proc.exitCode === null && proc.signalCode === null) {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }

  // Cancellation/timeout win over whatever the (now-dead) child happened to print.
  if (aborted.reason === "timeout") {
    throw new EngineTimeoutError(`engine timed out after ${timeoutMs}ms`);
  }
  if (aborted.reason === "external") {
    throw new EngineAbortError("engine run was cancelled");
  }

  const text = stdoutText.trim();

  // Exit 3 is special: the engine couldn't run. stdout may be empty; route to `doctor`.
  if (code === EXIT.engineUnavailable) {
    let detail = "engine unavailable — run `chord doctor`";
    if (text) {
      try {
        const out = parseEngineOutput(JSON.parse(text));
        if (out.kind === "error") detail = out.value.detail;
      } catch {
        /* keep the generic message */
      }
    }
    throw new EngineUnavailableError(detail);
  }

  // Killed by a signal we didn't send (e.g. external SIGKILL, OOM) → process-level failure.
  if (code === null) {
    throw new EngineSpawnError(`engine killed by signal ${proc.signalCode ?? "?"}`);
  }

  if (!text) {
    throw new EngineSpawnError(`engine produced no stdout (exit ${code})`);
  }

  // For exits 0/2/4 the stdout JSON is authoritative: an Analysis, or an `{ error }` envelope.
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ContractError(`engine stdout was not valid JSON (exit ${code}): ${clip(text)}`);
  }
  return parseEngineOutput(json); // throws ContractError on a malformed payload
}
