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

export type ContractVersion = `1.${number}.${number}`; // major-1 family; frontend rejects a mismatched MAJOR
export const CURRENT_CONTRACT_VERSION: ContractVersion = "1.0.0";

export type EngineCapability =
  | "key"
  | "keyCandidates"
  | "chords"
  | "beats"
  | "downbeats"
  | "timeSignature"
  | "extendedChords"; // refused at MVP (triads only)

export type ConfidenceKind = "posterior" | "correlation" | "heuristic";

export type EngineName = "librosa" | "essentia" | "btc";

export interface EngineInfo {
  name: EngineName;
  version: string;
  license: string; // "ISC" | "CC-BY-NC-SA-4.0" | "AGPL-3.0"
  modelVersions: Record<string, string>; // {} when rule-based (librosa)
  confidenceKind: ConfidenceKind; // correlation=librosa/btc key, posterior/heuristic reserved
}

/**
 * Response of the cheap `engine-info` command (decodes no audio). The frontend calls
 * this to build cache keys and discover capabilities without running a full analysis.
 * It is part of the locked IPC contract — see engine/engine-info.schema.json.
 */
export interface EngineInfoResponse extends EngineInfo {
  contractVersion: ContractVersion;
  capabilities: EngineCapability[];
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
  quality: "maj" | "min" | "N" | string; // triads, or extended labels (maj7/7/min7/sus4/…) from btc
  confidence: number | null; // null = engine exposes no per-segment confidence
}

export interface Analysis {
  contractVersion: ContractVersion;
  file: string;
  durationSec: number;
  engine: EngineInfo;
  engineCapabilities: EngineCapability[]; // drives which panels render
  vocabulary: "triads" | "extended"; // "extended" = 7ths/sus/etc. (btc large-voca)
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

/**
 * Process exit codes. stdout still carries JSON (an Analysis or an EngineError) for 0/2/4;
 * for `engine_unavailable` (3) there may be NO stdout — the caller routes to `doctor`.
 */
export const EXIT = {
  ok: 0,
  badInput: 2,
  engineUnavailable: 3,
  analysisFailed: 4,
} as const;

/** Canonical EngineError.kind -> process exit code. The engine and engine.ts share this. */
export const ERROR_KIND_EXIT: Record<EngineError["kind"], number> = {
  bad_input: EXIT.badInput,
  engine_unavailable: EXIT.engineUnavailable,
  decode_failed: EXIT.analysisFailed,
  internal: EXIT.analysisFailed,
};

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
