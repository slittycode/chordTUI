// tests/ts/setup.test.ts — the pure planSetup decision table (no `uv` spawned).
//
// btc is MIT, so there is no consent machinery: librosa (clean core) always installs, and btc
// (the accuracy default) installs unless `--no-btc` or `--engine librosa`. essentia is deferred.

import { test, expect } from "bun:test";
import { planSetup } from "../../src/cli/commands";

test("plain setup: clean core + btc (the accuracy default)", () => {
  const p = planSetup([]);
  expect(p.installs).toEqual(["librosa", "btc"]);
  expect(p.errors).toEqual([]);
});

test("--no-btc: clean core only", () => {
  const p = planSetup(["--no-btc"]);
  expect(p.installs).toEqual(["librosa"]);
  expect(p.errors).toEqual([]);
});

test("--engine librosa: clean core only", () => {
  const p = planSetup(["--engine", "librosa"]);
  expect(p.installs).toEqual(["librosa"]);
});

test("--engine btc: clean core + btc", () => {
  const p = planSetup(["--engine", "btc"]);
  expect(p.installs).toEqual(["librosa", "btc"]);
  expect(p.errors).toEqual([]);
});

test("--engine essentia: deferred error, installs nothing", () => {
  const p = planSetup(["--engine", "essentia"]);
  expect(p.installs).toEqual([]);
  expect(p.errors.join(" ")).toContain("essentia");
});

test("unknown engine / unknown flag: error, installs nothing", () => {
  expect(planSetup(["--engine", "banjo"]).errors.length).toBeGreaterThan(0);
  expect(planSetup(["--frobnicate"]).errors.length).toBeGreaterThan(0);
});
