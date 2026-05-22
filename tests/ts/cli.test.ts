// tests/ts/cli.test.ts — CLI commands driven against the real mock sidecar.
//
// Each command takes an injectable CliIO (captured into buffers here) and an injected engine
// base, so we exercise the full spawn → validate → render path without touching env or a TTY.
// Under `bun test`, process.stdout.isTTY is falsy, so the mock gate is deterministic.

import { test, expect } from "bun:test";
import {
  cmdAnalyze,
  cmdDoctor,
  cmdEngineInfo,
  cmdSetup,
  type CliIO,
} from "../../src/cli/commands";
import { validateAnalysis } from "../../src/core/validate";
import { ERROR_KIND_EXIT } from "../../src/core/types";

const ANALYZE = ["python3", "engine/mock_sidecar.py", "analyze"];
const ENGINE_INFO = ["python3", "engine/mock_sidecar.py", "engine-info"];

function captureIO(): { io: CliIO; out: () => string; err: () => string } {
  let out = "";
  let err = "";
  return {
    io: {
      out: (s) => {
        out += s;
      },
      err: (s) => {
        err += s;
      },
    },
    out: () => out,
    err: () => err,
  };
}

// ── analyze ─────────────────────────────────────────────────────────

test("analyze --json emits a valid sparse Analysis, exit 0", async () => {
  const c = captureIO();
  const code = await cmdAnalyze({ file: "x.wav", json: true, io: c.io, analyzeBase: ANALYZE });
  expect(code).toBe(0);
  const a = validateAnalysis(JSON.parse(c.out()));
  expect(a.engine.name).toBe("librosa");
  expect(a.engineCapabilities).toEqual(["key", "chords"]);
});

test("analyze --json emits a valid full Analysis, exit 0", async () => {
  const c = captureIO();
  const code = await cmdAnalyze({
    file: "x.wav",
    json: true,
    io: c.io,
    analyzeBase: [...ANALYZE, "--payload", "full"],
  });
  expect(code).toBe(0);
  const a = validateAnalysis(JSON.parse(c.out()));
  expect(a.engine.name).toBe("madmom");
  expect(a.keyCandidates?.length).toBe(3);
});

test("analyze summary prints key, engine, and progression with roman numerals", async () => {
  const c = captureIO();
  const code = await cmdAnalyze({ file: "x.wav", io: c.io, analyzeBase: ANALYZE });
  expect(code).toBe(0);
  const out = c.out();
  expect(out).toContain("C major");
  expect(out).toContain("librosa");
  expect(out).toContain("C (I) → F (IV) → G (V) → C (I)");
});

test("analyze error scenario → ERROR_KIND_EXIT.decode_failed + detail printed", async () => {
  const c = captureIO();
  const code = await cmdAnalyze({
    file: "x.wav",
    io: c.io,
    analyzeBase: [...ANALYZE, "--scenario", "error"],
  });
  expect(code).toBe(ERROR_KIND_EXIT.decode_failed); // 4
  expect(c.err()).toContain("mock decode failure");
});

test("analyze surfaces an exit-3 sidecar as engine-unavailable (exit 3)", async () => {
  const c = captureIO();
  const code = await cmdAnalyze({
    file: "x.wav",
    io: c.io,
    analyzeBase: ["python3", "-c", "import sys;sys.exit(3)"],
  });
  expect(code).toBe(3);
});

// ── mock gating (Decision 1) ────────────────────────────────────────

test("analyze refuses the mock under --json with no explicit override (exit 3)", async () => {
  const c = captureIO();
  const code = await cmdAnalyze({
    file: "x.wav",
    json: true,
    io: c.io,
    analyzeBase: ANALYZE,
    isMock: true,
    mockExplicit: false,
  });
  expect(code).toBe(3);
});

test("analyze allows an explicit mock under --json (exit 0)", async () => {
  const c = captureIO();
  const code = await cmdAnalyze({
    file: "x.wav",
    json: true,
    io: c.io,
    analyzeBase: ANALYZE,
    isMock: true,
    mockExplicit: true,
  });
  expect(code).toBe(0);
});

// ── engine-info ─────────────────────────────────────────────────────

test("engine-info summary prints name + capabilities", async () => {
  const c = captureIO();
  const code = await cmdEngineInfo({ io: c.io, engineInfoBase: ENGINE_INFO });
  expect(code).toBe(0);
  expect(c.out()).toContain("librosa");
  expect(c.out()).toContain("key, chords");
});

test("engine-info --json validates and exits 0", async () => {
  const c = captureIO();
  const code = await cmdEngineInfo({ json: true, io: c.io, engineInfoBase: ENGINE_INFO });
  expect(code).toBe(0);
  const info = JSON.parse(c.out());
  expect(info.name).toBe("librosa");
  expect(info.contractVersion).toMatch(/^1\./);
});

test("engine-info applies the same mock gate as analyze (exit 3 under --json)", async () => {
  const c = captureIO();
  const code = await cmdEngineInfo({
    json: true,
    io: c.io,
    engineInfoBase: ENGINE_INFO,
    isMock: true,
    mockExplicit: false,
  });
  expect(code).toBe(3);
});

// ── doctor / setup ──────────────────────────────────────────────────

test("doctor prints a probe table and returns 0", async () => {
  const c = captureIO();
  const code = await cmdDoctor({ io: c.io });
  expect(code).toBe(0);
  expect(c.out()).toContain("chordTUI doctor");
  expect(c.out()).toContain("engine (protocol)");
});

test("setup is an honest placeholder and returns 0", () => {
  const c = captureIO();
  const code = cmdSetup({ io: c.io });
  expect(code).toBe(0);
  expect(c.out()).toContain("not implemented");
});
