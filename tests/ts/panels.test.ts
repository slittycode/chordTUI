// tests/ts/panels.test.ts — pure capability-gating, against the real mock fixtures.
//
// Spawns the mock sidecar (sparse vs full) and runs the output through the real validator, so
// these assert the exact contract the engine emits — the same fixtures the component tests use.

import { test, expect } from "bun:test";
import { visiblePanels } from "../../src/core/panels";
import { validateAnalysis } from "../../src/core/validate";
import type { Analysis } from "../../src/core/types";

const MOCK = "engine/mock_sidecar.py";

function mock(payload: "sparse" | "full"): Analysis {
  const p = Bun.spawnSync(["python3", MOCK, "analyze", "--payload", payload]);
  return validateAnalysis(JSON.parse(p.stdout.toString()));
}

test("sparse (librosa): only chords is gated on; every advanced panel is hidden", () => {
  expect(visiblePanels(mock("sparse"))).toEqual({
    keyCandidates: false,
    beats: false,
    downbeats: false,
    timeSignature: false,
    chords: true,
  });
});

test("full (btc): every panel is visible", () => {
  expect(visiblePanels(mock("full"))).toEqual({
    keyCandidates: true,
    beats: true,
    downbeats: true,
    timeSignature: true,
    chords: true,
  });
});

test("a capability without its field (field null) stays hidden — null is removed, never faked", () => {
  const a = mock("full");
  const withNullBeats: Analysis = { ...a, beats: null };
  expect(visiblePanels(withNullBeats).beats).toBe(false);
  // the others on the same payload remain visible
  expect(visiblePanels(withNullBeats).timeSignature).toBe(true);
});
