// src/core/consent.ts — one-time NonCommercial consent for the madmom accuracy tier.
//
// madmom's pretrained models are CC-BY-NC-SA 4.0 (NonCommercial). PLAN.md §6 requires explicit
// consent before madmom is auto-used as the default engine. We record that consent in a tiny
// config file so the CLI's default-engine pick and the TUI's auto-upgrade only reach for madmom
// once the user has agreed. An explicit `--engine madmom` is itself consent (recorded on use).
//
// $CHORDTUI_CONFIG_DIR overrides the location (mirrors the other CHORDTUI_* env seams) so tests
// never touch the real ~/.config. All reads/writes are best-effort: a missing/corrupt file means
// "no consent", and a failed write never throws into a run.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface Config {
  madmomConsent?: boolean;
}

function configDir(): string {
  return process.env["CHORDTUI_CONFIG_DIR"] || join(homedir(), ".config", "chordtui");
}

function configPath(): string {
  return join(configDir(), "config.json");
}

function read(): Config {
  try {
    const raw = readFileSync(configPath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Config) : {};
  } catch {
    return {};
  }
}

/** True only when the user has explicitly accepted madmom's NonCommercial model licence. */
export function hasMadmomConsent(): boolean {
  return read().madmomConsent === true;
}

/** Record (or revoke) madmom NonCommercial consent. Best-effort; never throws. */
export function setMadmomConsent(value = true): void {
  try {
    const cfg = read();
    cfg.madmomConsent = value;
    const dir = configDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + "\n");
  } catch {
    /* consent persistence is best-effort */
  }
}
