import { test, expect } from "bun:test";
import { validateAnalysis, ContractError } from "../../src/core/validate";

const MOCK = "engine/mock_sidecar.py";

function runMock(args: string[]): { stdout: string; stderr: string; code: number | null } {
  const p = Bun.spawnSync(["python3", MOCK, ...args]);
  return {
    stdout: p.stdout.toString(),
    stderr: p.stderr.toString(),
    code: p.exitCode,
  };
}

test("sparse payload validates; capabilities are key+chords only; advanced fields null", () => {
  const { stdout } = runMock(["analyze", "--payload", "sparse"]);
  const a = validateAnalysis(JSON.parse(stdout));
  expect(a.engine.name).toBe("librosa");
  expect(a.engine.confidenceKind).toBe("correlation");
  expect(a.engineCapabilities).toEqual(["key", "chords"]);
  expect(a.keyCandidates).toBeNull();
  expect(a.beats).toBeNull();
  expect(a.downbeats).toBeNull();
  expect(a.timeSignature).toBeNull();
  expect(a.chords.every((c) => c.confidence === null)).toBe(true);
});

test("full payload validates; rich capabilities and populated advanced fields", () => {
  const { stdout } = runMock(["analyze", "--payload", "full"]);
  const a = validateAnalysis(JSON.parse(stdout));
  expect(a.engine.name).toBe("madmom");
  expect(a.engine.confidenceKind).toBe("posterior");
  expect(a.keyCandidates).not.toBeNull();
  expect(a.keyCandidates!.length).toBe(3);
  expect(a.beats).not.toBeNull();
  expect(a.timeSignature).toBe("4/4");
  expect(a.engineCapabilities).toContain("downbeats");
});

test("chords are gap-free and contiguous over [0, durationSec]", () => {
  const { stdout } = runMock(["analyze", "--payload", "full"]);
  const a = validateAnalysis(JSON.parse(stdout));
  expect(a.chords[0]!.start).toBe(0);
  for (let i = 0; i < a.chords.length - 1; i++) {
    expect(a.chords[i]!.end).toBeCloseTo(a.chords[i + 1]!.start, 6);
  }
  expect(a.chords.at(-1)!.end).toBeCloseTo(a.durationSec, 6);
});

test("NDJSON progress emits the ordered stages on stderr", () => {
  const { stderr } = runMock(["analyze", "--payload", "sparse"]);
  const events = stderr
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const stages = events.filter((e) => e.type === "progress").map((e) => e.stage);
  expect(stages).toEqual(["decode", "features", "beat-track", "chord-decode", "key-detect", "assemble"]);
});

test("error scenario emits an error envelope and a nonzero exit code", () => {
  const { stdout, code } = runMock(["analyze", "--scenario", "error"]);
  expect(code).not.toBe(0);
  const obj = JSON.parse(stdout);
  expect(obj.error.kind).toBe("decode_failed");
});

// --- validator rejection cases (the contract's teeth) ---

test("rejects a gap in the chord timeline", () => {
  const obj = JSON.parse(runMock(["analyze", "--payload", "sparse"]).stdout);
  obj.chords[1].start += 0.5; // introduce a gap
  expect(() => validateAnalysis(obj)).toThrow(ContractError);
});

test("rejects a missing required field (key)", () => {
  const obj = JSON.parse(runMock(["analyze", "--payload", "sparse"]).stdout);
  delete obj.key;
  expect(() => validateAnalysis(obj)).toThrow(ContractError);
});

test("rejects a missing nullable field (undefined != null)", () => {
  const obj = JSON.parse(runMock(["analyze", "--payload", "sparse"]).stdout);
  delete obj.beats; // must be present as null, not absent
  expect(() => validateAnalysis(obj)).toThrow(ContractError);
});

test('rejects an "N" segment that carries a root', () => {
  const obj = JSON.parse(runMock(["analyze", "--payload", "sparse"]).stdout);
  obj.chords[0].label = "N";
  obj.chords[0].quality = "N";
  // root left as "C" -> invalid
  expect(() => validateAnalysis(obj)).toThrow(ContractError);
});

test("rejects an incompatible contractVersion major", () => {
  const obj = JSON.parse(runMock(["analyze", "--payload", "sparse"]).stdout);
  obj.contractVersion = "2.0.0";
  expect(() => validateAnalysis(obj)).toThrow(ContractError);
});
