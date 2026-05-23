// tests/ts/consent.test.ts — madmom NonCommercial consent storage.
//
// $CHORDTUI_CONFIG_DIR points at a throwaway dir so the test never touches the real ~/.config.

import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "chordtui-consent-"));
process.env["CHORDTUI_CONFIG_DIR"] = DIR;

// Imported AFTER the env var is set (the module reads it lazily per call, so order is moot,
// but this documents the dependency).
const { hasMadmomConsent, setMadmomConsent } = await import("../../src/core/consent");

afterAll(() => {
  rmSync(DIR, { recursive: true, force: true });
  delete process.env["CHORDTUI_CONFIG_DIR"];
});

test("no consent by default (missing config)", () => {
  expect(hasMadmomConsent()).toBe(false);
});

test("setMadmomConsent() persists across reads", () => {
  setMadmomConsent();
  expect(hasMadmomConsent()).toBe(true);
});

test("consent can be revoked", () => {
  setMadmomConsent(false);
  expect(hasMadmomConsent()).toBe(false);
});
