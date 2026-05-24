// tests/ts/reducer.test.ts — the pure analysisReducer state machine (no renderer, no spawn).
//
// This is the safety net under the async hook: every transition the v4 plan table specifies,
// plus the runId stale-leg guard and the "unhandled (action,phase) = no-op" catch-all.

import { test, expect } from "bun:test";
import { analysisReducer, initialAnalysisState } from "../../src/hooks/useAnalysis";
import type { AnalysisState } from "../../src/hooks/useAnalysis";
import type { Analysis, EngineName } from "../../src/core/types";

function mkAnalysis(name: EngineName = "librosa"): Analysis {
  return {
    contractVersion: "1.0.0",
    file: "x.wav",
    durationSec: 0,
    engine: { name, version: "0", license: "ISC", modelVersions: {}, confidenceKind: "correlation" },
    engineCapabilities: ["key", "chords"],
    vocabulary: "triads",
    key: { tonic: "C", mode: "major", confidence: 0.9 },
    keyCandidates: null,
    chords: [],
    beats: null,
    downbeats: null,
    timeSignature: null,
  };
}

/** State after one ANALYZE_REQUESTED (the only way to enter a run). */
function requested(runId = 1, file = "x.wav"): AnalysisState {
  return analysisReducer(initialAnalysisState, { type: "ANALYZE_REQUESTED", runId, file });
}

test("ANALYZE_REQUESTED enters running-preview and establishes runId", () => {
  const s = requested(1, "song.wav");
  expect(s.phase).toBe("running-preview");
  expect(s.runId).toBe(1);
  expect(s.file).toBe("song.wav");
  expect(s.analysis).toBeNull();
});

test("ANALYZE_REQUESTED is accepted even when its runId differs from state (M1 carve-out)", () => {
  const prev: AnalysisState = { ...requested(5), phase: "done-upgrade" };
  const s = analysisReducer(prev, { type: "ANALYZE_REQUESTED", runId: 6, file: "n.wav" });
  expect(s.phase).toBe("running-preview");
  expect(s.runId).toBe(6);
});

test("PROGRESS sets stage while running; a stale-runId PROGRESS is dropped", () => {
  const s = analysisReducer(requested(1), { type: "PROGRESS", runId: 1, stage: "features" });
  expect(s.stage).toBe("features");
  const stale = analysisReducer(s, { type: "PROGRESS", runId: 99, stage: "assemble" });
  expect(stale.stage).toBe("features"); // unchanged
});

test("PREVIEW_DONE → done-preview with the preview analysis (isPreview true, stage cleared)", () => {
  const s = analysisReducer(
    { ...requested(1), stage: "assemble" },
    { type: "PREVIEW_DONE", runId: 1, analysis: mkAnalysis() },
  );
  expect(s.phase).toBe("done-preview");
  expect(s.isPreview).toBe(true);
  expect(s.analysis?.engine.name).toBe("librosa");
  expect(s.stage).toBeNull();
});

test("upgrade happy path: STARTED → DONE swaps in the upgrade (isPreview false)", () => {
  let s = analysisReducer(requested(1), { type: "PREVIEW_DONE", runId: 1, analysis: mkAnalysis("librosa") });
  s = analysisReducer(s, { type: "UPGRADE_STARTED", runId: 1 });
  expect(s.phase).toBe("running-upgrade");
  expect(s.isPreview).toBe(true);
  s = analysisReducer(s, { type: "UPGRADE_DONE", runId: 1, analysis: mkAnalysis("btc") });
  expect(s.phase).toBe("done-upgrade");
  expect(s.isPreview).toBe(false);
  expect(s.analysis?.engine.name).toBe("btc");
});

test("UPGRADE_FAILED keeps the preview and records an upgradeNote (the live MVP path)", () => {
  let s = analysisReducer(requested(1), { type: "PREVIEW_DONE", runId: 1, analysis: mkAnalysis() });
  s = analysisReducer(s, { type: "UPGRADE_STARTED", runId: 1 });
  s = analysisReducer(s, { type: "UPGRADE_FAILED", runId: 1, cause: "unavailable" });
  expect(s.phase).toBe("done-preview");
  expect(s.isPreview).toBe(true);
  expect(s.analysis).not.toBeNull(); // preview kept
  expect(s.upgradeNote).toContain("btc unavailable");
  expect(s.error).toBeNull();
});

test("ABORTED is state-keyed: no preview → idle; preview present → done-preview (kept)", () => {
  // no preview yet
  const a = analysisReducer(requested(1), { type: "ABORTED", runId: 1 });
  expect(a.phase).toBe("idle");
  expect(a.analysis).toBeNull();
  // preview present (cancel during upgrade)
  let s = analysisReducer(requested(2), { type: "PREVIEW_DONE", runId: 2, analysis: mkAnalysis() });
  s = analysisReducer(s, { type: "UPGRADE_STARTED", runId: 2 });
  s = analysisReducer(s, { type: "ABORTED", runId: 2 });
  expect(s.phase).toBe("done-preview");
  expect(s.analysis).not.toBeNull();
});

test("ERROR on the preview leg → error state, no analysis", () => {
  const s = analysisReducer(requested(1), {
    type: "ERROR",
    runId: 1,
    detail: "decode failed",
    hint: "is this audio?",
  });
  expect(s.phase).toBe("error");
  expect(s.analysis).toBeNull();
  expect(s.error).toEqual({ detail: "decode failed", hint: "is this audio?" });
});

test("CANCEL_REQUESTED toggles cancelling only while running; no-op otherwise", () => {
  expect(analysisReducer(requested(1), { type: "CANCEL_REQUESTED", runId: 1 }).phase).toBe("cancelling");
  // from idle: no-op
  expect(analysisReducer(initialAnalysisState, { type: "CANCEL_REQUESTED", runId: 0 }).phase).toBe("idle");
});

test("a stale leg cannot corrupt a newer run (old ABORTED after a new ANALYZE_REQUESTED is a no-op)", () => {
  // run 1 is in flight, then the user restarts → run 2.
  const run2 = analysisReducer(requested(1), { type: "ANALYZE_REQUESTED", runId: 2, file: "y.wav" });
  // run 1's cancelled leg lands its ABORTED late, carrying the OLD id.
  const after = analysisReducer(run2, { type: "ABORTED", runId: 1 });
  expect(after).toBe(run2); // dropped as stale — identical reference
  expect(after.runId).toBe(2);
  expect(after.phase).toBe("running-preview");
});

test("catch-all: a resolve landing after cancel (phase cancelling) is a no-op", () => {
  let s = analysisReducer(requested(1), { type: "CANCEL_REQUESTED", runId: 1 });
  expect(s.phase).toBe("cancelling");
  // PREVIEW_DONE requires running-preview; arriving in cancelling → unchanged.
  s = analysisReducer(s, { type: "PREVIEW_DONE", runId: 1, analysis: mkAnalysis() });
  expect(s.phase).toBe("cancelling");
  expect(s.analysis).toBeNull();
});
