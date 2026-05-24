// tests/ts/setup.test.ts — the pure planSetup decision table (no `uv` spawned).
//
// planSetup encodes the single load-bearing invariant: madmom (CC-BY-NC-SA NonCommercial) is
// NEVER scheduled for install without explicit consent — a flag, or (via promptMadmom) an
// interactive yes. Every row below pins one cell of that table.

import { test, expect } from "bun:test";
import { planSetup } from "../../src/cli/commands";

test("plain setup in a TTY: clean core + a default-yes madmom prompt (not pre-scheduled)", () => {
  const p = planSetup([], { isTTY: true });
  expect(p.installs).toEqual(["librosa"]);
  expect(p.promptMadmom).toBe(true);
  expect(p.errors).toEqual([]);
});

test("plain setup without a TTY: clean core only + a hint, no silent madmom", () => {
  const p = planSetup([], { isTTY: false });
  expect(p.installs).toEqual(["librosa"]);
  expect(p.promptMadmom).toBe(false);
  expect(p.errors).toEqual([]);
  expect(p.notices.join(" ")).toContain("--accept-noncommercial");
});

test("--no-madmom: clean core only, no prompt", () => {
  const p = planSetup(["--no-madmom"], { isTTY: true });
  expect(p.installs).toEqual(["librosa"]);
  expect(p.promptMadmom).toBe(false);
});

test("--accept-noncommercial: schedules madmom with the NC notice, no prompt", () => {
  const p = planSetup(["--accept-noncommercial"], { isTTY: false });
  expect(p.installs).toEqual(["librosa", "madmom"]);
  expect(p.promptMadmom).toBe(false);
  expect(p.notices.join(" ")).toContain("CC-BY-NC-SA");
});

test("--engine librosa: librosa only, no prompt", () => {
  const p = planSetup(["--engine", "librosa"], { isTTY: true });
  expect(p.installs).toEqual(["librosa"]);
  expect(p.promptMadmom).toBe(false);
});

test("--engine madmom in a TTY: prompts (consent), not pre-scheduled", () => {
  const p = planSetup(["--engine", "madmom"], { isTTY: true });
  expect(p.installs).toEqual(["librosa"]);
  expect(p.promptMadmom).toBe(true);
  expect(p.errors).toEqual([]);
});

test("--engine madmom --accept-noncommercial: schedules madmom, no prompt", () => {
  const p = planSetup(["--engine", "madmom", "--accept-noncommercial"], { isTTY: false });
  expect(p.installs).toEqual(["librosa", "madmom"]);
  expect(p.promptMadmom).toBe(false);
});

test("--engine madmom without a TTY or consent: refuses (never silent)", () => {
  const p = planSetup(["--engine", "madmom"], { isTTY: false });
  expect(p.installs).toEqual([]);
  expect(p.errors.length).toBeGreaterThan(0);
  expect(p.errors.join(" ")).toContain("--accept-noncommercial");
});

test("--engine essentia: deferred error, installs nothing", () => {
  const p = planSetup(["--engine", "essentia"], { isTTY: true });
  expect(p.installs).toEqual([]);
  expect(p.errors.join(" ")).toContain("essentia");
});

test("unknown engine / unknown flag: error, installs nothing", () => {
  expect(planSetup(["--engine", "banjo"], { isTTY: true }).errors.length).toBeGreaterThan(0);
  expect(planSetup(["--frobnicate"], { isTTY: true }).errors.length).toBeGreaterThan(0);
});
