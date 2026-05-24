// src/core/music.ts — pure music-theory helpers (no I/O).
//
// Per PLAN.md §3, enharmonic spelling and roman numerals are derived TS-side from the
// engine's (key, root, quality) — they are never sent over the wire, and out-of-key /
// unknown chords get NO numeral (we omit, never invent). PLAN.md §5 makes this file the
// home for enharmonic spelling + in-key roman numerals. Everything here is a pure function
// of its arguments so it can be unit-tested without a renderer or a sidecar.

import type { ChordSegment, ConfidenceKind, KeyResult } from "./types";

/** The minimal key context the helpers need (a KeyResult satisfies this structurally). */
export type KeyContext = Pick<KeyResult, "tonic" | "mode">;

const LETTER_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

// Two spellings of the 12 pitch classes; we pick one per key (see keyPrefersFlats).
const SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLAT_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];

/**
 * Parse a note name to a pitch class 0–11, or null if unparseable. Accepts a letter A–G
 * followed by zero or more accidentals of a SINGLE kind ("C", "F#", "Bb", "C##", "Cb").
 * Mixed accidentals ("C#b") and non-notes ("H", "") are rejected.
 */
export function noteToPc(name: string): number | null {
  const m = /^([A-Ga-g])(#*|b*)$/.exec(name.trim());
  if (!m) return null;
  const letter = m[1];
  const accidentals = m[2];
  if (letter === undefined || accidentals === undefined) return null;
  let pc = LETTER_PC[letter.toUpperCase()];
  if (pc === undefined) return null;
  for (const ch of accidentals) pc += ch === "#" ? 1 : -1;
  return ((pc % 12) + 12) % 12;
}

/**
 * Whether a key is conventionally spelled with flats (vs sharps). The tonic's own
 * accidental decides enharmonic tonics (Gb vs F#, Db vs C#); natural-letter tonics fall
 * back to the circle-of-fifths split. C major / A minor default to sharps.
 */
export function keyPrefersFlats(tonic: string, mode: "major" | "minor"): boolean {
  if (tonic.includes("b")) return true;
  if (tonic.includes("#")) return false;
  const letter = tonic.charAt(0).toUpperCase();
  return mode === "major" ? letter === "F" : ["D", "G", "C", "F"].includes(letter);
}

function qualitySuffix(quality: string): string {
  if (quality === "maj") return "";
  if (quality === "min") return "m";
  return quality; // future vocab (e.g. "dim", "7") rendered verbatim
}

/**
 * Display label for a chord, respelled to the key's accidental convention. A no-chord
 * segment ("N" / null root) renders as "N.C." (no chord). An unparseable root falls back
 * to the engine's own label — we never synthesize a label from a root we can't read.
 */
export function formatChordLabel(
  seg: Pick<ChordSegment, "root" | "quality" | "label">,
  key: KeyContext,
): string {
  if (seg.quality === "N" || seg.root === null) return "N.C.";
  const pc = noteToPc(seg.root);
  if (pc === null) return seg.label;
  const names = keyPrefersFlats(key.tonic, key.mode) ? FLAT_NAMES : SHARP_NAMES;
  const name = names[pc];
  if (name === undefined) return seg.label; // unreachable (pc is 0–11), but strict-mode safe
  return name + qualitySuffix(seg.quality);
}

// In-key triads as (interval-from-tonic, quality) → roman numeral. The (interval, quality)
// pair is the lookup key: degree 7 in minor holds BOTH v (natural) and V (harmonic-minor
// dominant), so quality — not row order — disambiguates them. Diminished degrees (vii° in
// major, ii° in minor) are omitted: the MVP vocabulary is maj/min triads only.
interface RomanRow {
  interval: number;
  quality: "maj" | "min";
  numeral: string;
}

const MAJOR_ROWS: RomanRow[] = [
  { interval: 0, quality: "maj", numeral: "I" },
  { interval: 2, quality: "min", numeral: "ii" },
  { interval: 4, quality: "min", numeral: "iii" },
  { interval: 5, quality: "maj", numeral: "IV" },
  { interval: 7, quality: "maj", numeral: "V" },
  { interval: 9, quality: "min", numeral: "vi" },
];

const MINOR_ROWS: RomanRow[] = [
  { interval: 0, quality: "min", numeral: "i" },
  { interval: 3, quality: "maj", numeral: "III" },
  { interval: 5, quality: "min", numeral: "iv" },
  { interval: 7, quality: "min", numeral: "v" },
  { interval: 7, quality: "maj", numeral: "V" }, // harmonic-minor dominant — in-key, not invented
  { interval: 8, quality: "maj", numeral: "VI" },
  { interval: 10, quality: "maj", numeral: "VII" },
];

// Extended (btc large-voca) qualities → the base triad used for the diatonic degree lookup, plus
// a numeral suffix. So a diatonic seventh keeps its degree and shows the extension: G7 in C → V7,
// Dm7 in C → ii7, Cmaj7 → Imaj7. dim / aug / sus2 / sus4 and the (half-)diminished sevenths are
// intentionally absent — their degree is ambiguous or chromatic, so we omit the numeral rather
// than invent one (PLAN.md §3, same discipline as out-of-key chords).
const EXTENDED_BASE: Record<string, { base: "maj" | "min"; suffix: string }> = {
  maj6: { base: "maj", suffix: "6" },
  maj7: { base: "maj", suffix: "maj7" },
  "7": { base: "maj", suffix: "7" }, // dominant seventh (major triad + ♭7)
  min6: { base: "min", suffix: "6" },
  min7: { base: "min", suffix: "7" },
  minmaj7: { base: "min", suffix: "maj7" },
};

/**
 * In-key roman numeral for a chord, or null when out-of-key or unknown. Handles maj/min triads
 * and the common diatonic sevenths/sixths (V7, ii7, Imaj7, …); returns null for "N", unparseable
 * root/tonic, dim/aug/sus and (half-)diminished sevenths, and any chord whose (degree, base
 * triad) is not diatonic — we omit rather than invent (PLAN.md §3).
 */
export function romanNumeral(
  root: string | null,
  quality: string,
  key: KeyContext,
): string | null {
  if (root === null) return null;
  let base: "maj" | "min";
  let suffix = "";
  if (quality === "maj" || quality === "min") {
    base = quality;
  } else {
    const ext = EXTENDED_BASE[quality];
    if (!ext) return null; // N, dim, aug, sus, dim7, hdim7 → no numeral
    base = ext.base;
    suffix = ext.suffix;
  }
  const r = noteToPc(root);
  const t = noteToPc(key.tonic);
  if (r === null || t === null) return null;
  const interval = (((r - t) % 12) + 12) % 12;
  const rows = key.mode === "major" ? MAJOR_ROWS : MINOR_ROWS;
  const row = rows.find((x) => x.interval === interval && x.quality === base);
  return row ? row.numeral + suffix : null;
}

/** A maximal run of consecutive segments sharing the same (root, quality). */
export interface ChordRun {
  start: number;
  end: number;
  root: string | null;
  quality: string;
  label: string;
}

/**
 * Collapse adjacent segments with identical (root, quality) into runs — including no-chord
 * runs (root null / quality "N"). Preserves the first segment's fields + start and the last
 * merged segment's end. The gap-free invariant is preserved by construction.
 */
export function collapseProgression(chords: ChordSegment[]): ChordRun[] {
  const runs: ChordRun[] = [];
  let prev: ChordRun | null = null;
  for (const seg of chords) {
    if (prev !== null && prev.root === seg.root && prev.quality === seg.quality) {
      prev.end = seg.end;
      continue;
    }
    prev = {
      start: seg.start,
      end: seg.end,
      root: seg.root,
      quality: seg.quality,
      label: seg.label,
    };
    runs.push(prev);
  }
  return runs;
}

// ── color / category by chord quality ───────────────────────────────
// Pure mapping for color-coding and grouping. The ChordTimeline component (Phase 4a) is the
// intended consumer; kept here so the mapping lives with the other quality-aware helpers.

export type ChordCategory = "major" | "minor" | "none" | "other";

/** Coarse category for a chord quality. "other" covers future/extended qualities. */
export function chordCategory(quality: string): ChordCategory {
  if (quality === "maj") return "major";
  if (quality === "min") return "minor";
  if (quality === "N") return "none";
  return "other";
}

/** Hex color per category (OpenTUI fg/bg format, "#RRGGBB"). */
export const QUALITY_COLORS: Record<ChordCategory, string> = {
  major: "#7CC4FF", // blue
  minor: "#C792EA", // purple
  none: "#5C6370", // gray — no-chord
  other: "#E5C07B", // amber — extended / unknown
};

/** Hex color for a chord quality, via its category. */
export function colorForQuality(quality: string): string {
  return QUALITY_COLORS[chordCategory(quality)];
}

/** Human-readable key, e.g. "C major". */
export function formatKey(key: KeyContext): string {
  return `${key.tonic} ${key.mode}`;
}

/** One-sentence gloss of what a confidence number means, per the engine's confidenceKind. */
export function confidenceMeaning(kind: ConfidenceKind): string {
  switch (kind) {
    case "posterior":
      return "model posterior probability (0–1; higher = more certain)";
    case "correlation":
      return "template-correlation score, not a true probability";
    case "heuristic":
      return "rule-based heuristic score, not a true probability";
  }
}
