// tests/ts/music.test.ts — the pure music helpers (no spawn, no I/O).

import { test, expect } from "bun:test";
import {
  chordCategory,
  collapseProgression,
  colorForQuality,
  confidenceMeaning,
  formatChordLabel,
  formatKey,
  keyPrefersFlats,
  noteToPc,
  QUALITY_COLORS,
  romanNumeral,
} from "../../src/core/music";
import type { ChordSegment } from "../../src/core/types";

const seg = (
  start: number,
  end: number,
  root: string | null,
  quality: string,
  label: string,
): ChordSegment => ({ start, end, root, quality, label, confidence: null });

// ── noteToPc ────────────────────────────────────────────────────────

test("noteToPc parses naturals, accidentals, and folds octave-equivalents", () => {
  expect(noteToPc("C")).toBe(0);
  expect(noteToPc("D")).toBe(2);
  expect(noteToPc("E")).toBe(4);
  expect(noteToPc("F")).toBe(5);
  expect(noteToPc("G")).toBe(7);
  expect(noteToPc("A")).toBe(9);
  expect(noteToPc("B")).toBe(11);
  expect(noteToPc("F#")).toBe(6);
  expect(noteToPc("Gb")).toBe(6);
  expect(noteToPc("Bb")).toBe(10);
  expect(noteToPc("Db")).toBe(1);
  expect(noteToPc("C##")).toBe(2);
  expect(noteToPc("Cb")).toBe(11);
  expect(noteToPc("B#")).toBe(0);
  expect(noteToPc("E#")).toBe(5);
  expect(noteToPc("Fb")).toBe(4);
  expect(noteToPc("c")).toBe(0); // lenient about case
});

test("noteToPc rejects non-notes and mixed accidentals", () => {
  expect(noteToPc("H")).toBeNull();
  expect(noteToPc("")).toBeNull();
  expect(noteToPc("C#b")).toBeNull(); // mixed accidentals
  expect(noteToPc("##")).toBeNull();
  expect(noteToPc("x")).toBeNull();
});

// ── keyPrefersFlats (all 24 keys) ───────────────────────────────────

test("keyPrefersFlats — major keys split by the circle of fifths", () => {
  for (const t of ["F", "Bb", "Eb", "Ab", "Db", "Gb", "Cb"]) {
    expect(keyPrefersFlats(t, "major")).toBe(true);
  }
  for (const t of ["C", "G", "D", "A", "E", "B", "F#", "C#"]) {
    expect(keyPrefersFlats(t, "major")).toBe(false);
  }
});

test("keyPrefersFlats — minor keys split by the circle of fifths", () => {
  for (const t of ["D", "G", "C", "F", "Bb", "Eb", "Ab"]) {
    expect(keyPrefersFlats(t, "minor")).toBe(true);
  }
  for (const t of ["A", "E", "B", "F#", "C#", "G#", "D#", "A#"]) {
    expect(keyPrefersFlats(t, "minor")).toBe(false);
  }
});

// ── formatChordLabel ────────────────────────────────────────────────

test("formatChordLabel respells to the key's accidental convention", () => {
  // E minor → sharps: a flat-spelled root respells to sharp.
  expect(formatChordLabel(seg(0, 1, "Bb", "maj", "Bb"), { tonic: "E", mode: "minor" })).toBe("A#");
  // F major → flats: a sharp-spelled root respells to flat.
  expect(formatChordLabel(seg(0, 1, "C#", "maj", "C#"), { tonic: "F", mode: "major" })).toBe("Db");
});

test("formatChordLabel suffixes quality; N.C. and unparseable-root fallbacks", () => {
  const Cmaj = { tonic: "C", mode: "major" } as const;
  expect(formatChordLabel(seg(0, 1, "C", "maj", "C"), Cmaj)).toBe("C");
  expect(formatChordLabel(seg(0, 1, "A", "min", "Am"), Cmaj)).toBe("Am");
  expect(formatChordLabel(seg(0, 1, "G", "dim", "Gdim"), Cmaj)).toBe("Gdim"); // unknown quality verbatim
  expect(formatChordLabel(seg(0, 1, null, "N", "N"), Cmaj)).toBe("N.C.");
  expect(formatChordLabel(seg(0, 1, "X", "maj", "Xchord"), Cmaj)).toBe("Xchord"); // falls back to label
});

// ── romanNumeral ────────────────────────────────────────────────────

test("romanNumeral — major-key diatonic triads", () => {
  const k = { tonic: "C", mode: "major" } as const;
  expect(romanNumeral("C", "maj", k)).toBe("I");
  expect(romanNumeral("D", "min", k)).toBe("ii");
  expect(romanNumeral("E", "min", k)).toBe("iii");
  expect(romanNumeral("F", "maj", k)).toBe("IV");
  expect(romanNumeral("G", "maj", k)).toBe("V");
  expect(romanNumeral("A", "min", k)).toBe("vi");
});

test("romanNumeral — the v vs V collision is resolved by quality (A minor)", () => {
  const k = { tonic: "A", mode: "minor" } as const;
  expect(romanNumeral("E", "maj", k)).toBe("V"); // harmonic-minor dominant
  expect(romanNumeral("E", "min", k)).toBe("v"); // natural-minor v
  expect(romanNumeral("A", "min", k)).toBe("i");
  expect(romanNumeral("C", "maj", k)).toBe("III");
  expect(romanNumeral("G", "maj", k)).toBe("VII");
});

test("romanNumeral omits out-of-key / unknown chords (never invents)", () => {
  const k = { tonic: "C", mode: "major" } as const;
  expect(romanNumeral("C#", "maj", k)).toBeNull(); // out of key
  expect(romanNumeral("B", "maj", k)).toBeNull(); // wrong quality at degree (would be vii°)
  expect(romanNumeral("C", "N", k)).toBeNull(); // no-chord
  expect(romanNumeral(null, "maj", k)).toBeNull();
});

test("romanNumeral — diatonic extended chords (btc large-voca) keep degree + extension", () => {
  const k = { tonic: "C", mode: "major" } as const;
  expect(romanNumeral("G", "7", k)).toBe("V7"); // dominant seventh
  expect(romanNumeral("C", "maj7", k)).toBe("Imaj7");
  expect(romanNumeral("F", "maj7", k)).toBe("IVmaj7");
  expect(romanNumeral("D", "min7", k)).toBe("ii7");
  expect(romanNumeral("A", "min7", k)).toBe("vi7");
  expect(romanNumeral("A", "min6", k)).toBe("vi6");
});

test("romanNumeral — ambiguous/chromatic extended qualities are omitted (never invented)", () => {
  const k = { tonic: "C", mode: "major" } as const;
  expect(romanNumeral("G", "sus4", k)).toBeNull();
  expect(romanNumeral("C", "dim", k)).toBeNull();
  expect(romanNumeral("C", "aug", k)).toBeNull();
  expect(romanNumeral("B", "hdim7", k)).toBeNull(); // vii half-dim — omitted by design
  expect(romanNumeral("C#", "7", k)).toBeNull(); // out of key even as a dominant
});

// ── collapseProgression ─────────────────────────────────────────────

test("collapseProgression merges adjacent equal runs, including N-runs", () => {
  const runs = collapseProgression([
    seg(0, 1, "C", "maj", "C"),
    seg(1, 2, "C", "maj", "C"),
    seg(2, 3, "F", "maj", "F"),
    seg(3, 4, null, "N", "N"),
    seg(4, 5, null, "N", "N"),
  ]);
  expect(runs.length).toBe(3);
  expect(runs[0]).toMatchObject({ root: "C", quality: "maj", start: 0, end: 2 });
  expect(runs[1]).toMatchObject({ root: "F", quality: "maj", start: 2, end: 3 });
  expect(runs[2]).toMatchObject({ root: null, quality: "N", start: 3, end: 5 });
});

test("collapseProgression handles empty and single-segment inputs", () => {
  expect(collapseProgression([])).toEqual([]);
  const one = collapseProgression([seg(0, 2, "G", "maj", "G")]);
  expect(one.length).toBe(1);
  expect(one[0]).toMatchObject({ start: 0, end: 2, root: "G" });
});

// ── small formatters ────────────────────────────────────────────────

test("formatKey and confidenceMeaning", () => {
  expect(formatKey({ tonic: "C", mode: "major" })).toBe("C major");
  expect(formatKey({ tonic: "F#", mode: "minor" })).toBe("F# minor");
  expect(confidenceMeaning("posterior")).toContain("probability");
  expect(confidenceMeaning("correlation")).toContain("correlation");
  expect(confidenceMeaning("heuristic")).toContain("heuristic");
});

test("chordCategory / colorForQuality map quality to category and hex color", () => {
  expect(chordCategory("maj")).toBe("major");
  expect(chordCategory("min")).toBe("minor");
  expect(chordCategory("N")).toBe("none");
  expect(chordCategory("dim")).toBe("other"); // future/extended vocab
  expect(colorForQuality("maj")).toBe(QUALITY_COLORS.major);
  expect(colorForQuality("N")).toBe(QUALITY_COLORS.none);
  expect(colorForQuality("7")).toBe(QUALITY_COLORS.other);
  for (const c of Object.values(QUALITY_COLORS)) expect(c).toMatch(/^#[0-9A-Fa-f]{6}$/);
});
