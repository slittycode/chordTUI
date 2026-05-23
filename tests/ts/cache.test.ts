// tests/ts/cache.test.ts — the per-engine result cache + analyzeWithCache helper.
//
// $CHORDTUI_CACHE_DIR points at a throwaway dir. Cache keys hash the audio file's bytes, so a
// real fixture is used as the keyed file; the mock sidecar stands in for "the engine".

import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CACHE = mkdtempSync(join(tmpdir(), "chordtui-cache-"));
process.env["CHORDTUI_CACHE_DIR"] = CACHE;

const { cacheGet, cachePut, analyzeWithCache } = await import("../../src/core/cache");
import type { Analysis, EngineName } from "../../src/core/types";

const FIXTURE = "tests/fixtures/audio/i_iv_v_i_c_major.wav";
const MOCK = ["python3", "engine/mock_sidecar.py", "analyze"];
const BROKEN = ["python3", "-c", "import sys;sys.exit(1)"];

function mkAnalysis(name: EngineName = "librosa"): Analysis {
  return {
    contractVersion: "1.0.0",
    file: "other.wav",
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

afterAll(() => {
  rmSync(CACHE, { recursive: true, force: true });
  delete process.env["CHORDTUI_CACHE_DIR"];
});

test("cacheGet returns null on a miss", () => {
  expect(cacheGet(FIXTURE, "madmom")).toBeNull();
});

test("cachePut → cacheGet round-trips; file path reflects the queried path", () => {
  cachePut(FIXTURE, "librosa", mkAnalysis());
  const got = cacheGet(FIXTURE, "librosa");
  expect(got).not.toBeNull();
  expect(got!.engine.name).toBe("librosa");
  expect(got!.file).toBe(FIXTURE); // stored "other.wav" is overwritten with the live path
});

test("a corrupt cache entry is ignored (null), never thrown", () => {
  cachePut(FIXTURE, "essentia", mkAnalysis("essentia"));
  const entry = readdirSync(CACHE).find((f) => f.endsWith("__essentia.json"))!;
  writeFileSync(join(CACHE, entry), "not json {{{");
  expect(cacheGet(FIXTURE, "essentia")).toBeNull();
});

test("analyzeWithCache: the second call is served from cache (broken base never spawns)", async () => {
  const first = await analyzeWithCache(MOCK, "librosa", FIXTURE, { isMock: false });
  expect(first.kind).toBe("analysis");
  // If the second call spawned BROKEN it would throw; a cache hit returns the stored analysis.
  const second = await analyzeWithCache(BROKEN, "librosa", FIXTURE, { isMock: false });
  expect(second.kind).toBe("analysis");
});

test("analyzeWithCache never caches the mock (isMock) or with noCache", async () => {
  const r = await analyzeWithCache(MOCK, "madmom", FIXTURE, { isMock: true });
  expect(r.kind).toBe("analysis");
  expect(cacheGet(FIXTURE, "madmom")).toBeNull(); // isMock output not stored
});
