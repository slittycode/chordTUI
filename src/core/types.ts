// src/core/types.ts — the sole frontend↔engine coupling.
//
// Every analysis result crossing the Bun.spawn boundary conforms to `Analysis`.
// Rules enforced by validate.ts (and mirrored in engine/schema.json):
//   1. Advanced fields are `T | null`, never `undefined`. `null` means "this engine
//      did not compute it" → the UI removes that sub-feature. A *missing* required
//      field means malformed output → the run is treated as an error.
//   2. `chords[]` is gap-free and contiguous over [0, durationSec]:
//      chords[i].end === chords[i+1].start; silence is an explicit "N" segment.
//   3. Enharmonic spelling and roman numerals are derived TS-side (music.ts) from
//      (key, root, quality); they are never sent over the wire.

export type ContractVersion = "1.0.0"; // frontend rejects a mismatched MAJOR

export type EngineCapability =
  | "key"
  | "keyCandidates"
  | "chords"
  | "beats"
  | "downbeats"
  | "timeSignature"
  | "extendedChords"; // refused at MVP (triads only)

export type ConfidenceKind = "posterior" | "correlation" | "heuristic";

export type EngineName = "librosa" | "madmom" | "essentia";

export interface EngineInfo {
  name: EngineName;
  version: string;
  license: string; // "ISC" | "CC-BY-NC-SA-4.0" | "AGPL-3.0"
  modelVersions: Record<string, string>; // {} when rule-based (librosa)
  confidenceKind: ConfidenceKind; // posterior=madmom, correlation=librosa key, heuristic=essentia
}

export interface KeyResult {
  tonic: string; // e.g. "C", "F#", "Bb" (engine-native; respelled TS-side per key)
  mode: "major" | "minor";
  confidence: number; // 0..1, interpret per EngineInfo.confidenceKind
}

export type KeyCandidate = KeyResult;

/**
 * Gap-free, contiguous over [0, durationSec]. Silence / unknown spans are explicit
 * "N" (no-chord) segments, never gaps. label === "N" => root === null, quality === "N".
 */
export interface ChordSegment {
  start: number; // seconds, inclusive
  end: number; // seconds, exclusive; segment[i].end === segment[i+1].start
  label: string; // "C", "Am", "N"
  root: string | null; // null only when label === "N"
  quality: "maj" | "min" | "N" | string; // triads at MVP; string allows future vocab
  confidence: number | null; // null = engine exposes no per-segment confidence
}

export interface Analysis {
  contractVersion: ContractVersion;
  file: string;
  durationSec: number;
  engine: EngineInfo;
  engineCapabilities: EngineCapability[]; // drives which panels render
  vocabulary: "triads"; // "extended" refused at MVP
  key: KeyResult;

  // ---- Nullable advanced fields (null = engine could not compute) ----
  keyCandidates: KeyCandidate[] | null; // top-3 alternatives
  chords: ChordSegment[]; // always present, gap-free
  beats: number[] | null; // beat onset times (s)
  downbeats: number[] | null; // downbeat onset times (s)
  timeSignature: string | null; // e.g. "4/4"
}

/** Sole error shape the engine may emit on stdout (instead of an Analysis). */
export interface EngineError {
  kind: "bad_input" | "decode_failed" | "engine_unavailable" | "internal";
  detail: string;
  hint?: string;
}

/** NDJSON line types streamed on the engine's stderr. */
export type EngineEvent =
  | { type: "progress"; stage: EngineStage; index?: number; total?: number }
  | { type: "log"; level: "info" | "warn" | "error"; msg: string };

export type EngineStage =
  | "decode"
  | "features"
  | "beat-track"
  | "chord-decode"
  | "key-detect"
  | "assemble";

export const ENGINE_STAGES: EngineStage[] = [
  "decode",
  "features",
  "beat-track",
  "chord-decode",
  "key-detect",
  "assemble",
];
