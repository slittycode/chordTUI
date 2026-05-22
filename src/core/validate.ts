// src/core/validate.ts — runtime validation of engine output.
//
// TS types erase at runtime, so engine.ts must validate parsed JSON before trusting
// it. We hand-roll the check (the contract is small and stable) rather than pull in a
// JSON-schema dependency. Python validates the same payloads against engine/schema.json;
// the round-trip tests assert both sides agree, including the gap-free invariant that
// JSON Schema cannot express.

import type {
  Analysis,
  ConfidenceKind,
  EngineCapability,
  EngineInfo,
  EngineName,
  KeyCandidate,
  KeyResult,
} from "./types";

const CONTRACT_MAJOR = 1;
const EPS = 1e-6;

const CONFIDENCE_KINDS: ConfidenceKind[] = ["posterior", "correlation", "heuristic"];
const ENGINE_NAMES: EngineName[] = ["librosa", "madmom", "essentia"];
const CAPABILITIES: EngineCapability[] = [
  "key",
  "keyCandidates",
  "chords",
  "beats",
  "downbeats",
  "timeSignature",
  "extendedChords",
];

/** Thrown when engine output does not conform to the contract. */
export class ContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractError";
  }
}

function fail(msg: string): never {
  throw new ContractError(msg);
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function reqNum(o: Record<string, unknown>, k: string, where: string): number {
  const v = o[k];
  if (typeof v !== "number" || Number.isNaN(v)) {
    fail(`${where}: expected number at "${k}", got ${JSON.stringify(v)}`);
  }
  return v;
}

function reqStr(o: Record<string, unknown>, k: string, where: string): string {
  const v = o[k];
  if (typeof v !== "string") {
    fail(`${where}: expected string at "${k}", got ${JSON.stringify(v)}`);
  }
  return v;
}

/** A nullable field must be PRESENT — `null` is allowed, `undefined` (missing) is an error. */
function numArrayOrNull(o: Record<string, unknown>, k: string): number[] | null {
  const v = o[k];
  if (v === undefined) fail(`missing required field "${k}" (use null if not computed)`);
  if (v === null) return null;
  if (!Array.isArray(v) || v.some((n) => typeof n !== "number" || Number.isNaN(n))) {
    fail(`"${k}": expected number[] | null`);
  }
  return v as number[];
}

function validateKey(v: unknown, where: string): KeyResult {
  if (!isObj(v)) fail(`${where}: must be an object`);
  const tonic = reqStr(v, "tonic", where);
  const mode = reqStr(v, "mode", where);
  if (mode !== "major" && mode !== "minor") fail(`${where}.mode must be "major" | "minor"`);
  const confidence = reqNum(v, "confidence", where);
  return { tonic, mode, confidence };
}

function validateEngine(v: unknown): EngineInfo {
  if (!isObj(v)) fail(`"engine" must be an object`);
  const name = reqStr(v, "name", "engine") as EngineName;
  if (!ENGINE_NAMES.includes(name)) fail(`engine.name invalid: ${name}`);
  const confidenceKind = reqStr(v, "confidenceKind", "engine") as ConfidenceKind;
  if (!CONFIDENCE_KINDS.includes(confidenceKind)) {
    fail(`engine.confidenceKind invalid: ${confidenceKind}`);
  }
  const mv = v["modelVersions"];
  if (!isObj(mv) || Object.values(mv).some((x) => typeof x !== "string")) {
    fail(`engine.modelVersions must be Record<string, string>`);
  }
  return {
    name,
    version: reqStr(v, "version", "engine"),
    license: reqStr(v, "license", "engine"),
    modelVersions: mv as Record<string, string>,
    confidenceKind,
  };
}

function validateChords(v: unknown, durationSec: number): Analysis["chords"] {
  if (!Array.isArray(v)) fail(`"chords" must be an array`);
  if (v.length === 0) {
    if (durationSec > EPS) fail(`"chords" is empty but durationSec=${durationSec}`);
    return [];
  }
  const out: Analysis["chords"] = [];
  let prevEnd = 0;
  for (let i = 0; i < v.length; i++) {
    const where = `chords[${i}]`;
    const s = v[i];
    if (!isObj(s)) fail(`${where}: must be an object`);
    const start = reqNum(s, "start", where);
    const end = reqNum(s, "end", where);
    const label = reqStr(s, "label", where);
    const quality = reqStr(s, "quality", where);

    const root = s["root"];
    if (root !== null && typeof root !== "string") fail(`${where}.root must be string | null`);

    const confidence = s["confidence"];
    if (confidence !== null && (typeof confidence !== "number" || Number.isNaN(confidence))) {
      fail(`${where}.confidence must be number | null`);
    }

    if (end <= start) fail(`${where}: end (${end}) must be > start (${start})`);
    if (Math.abs(start - prevEnd) > EPS) {
      fail(`${where}: not contiguous — start ${start} != previous end ${prevEnd}`);
    }
    if (label === "N") {
      if (root !== null) fail(`${where}: label "N" requires root === null`);
      if (quality !== "N") fail(`${where}: label "N" requires quality === "N"`);
    } else if (root === null) {
      fail(`${where}: non-"N" segment requires a non-null root`);
    }

    out.push({
      start,
      end,
      label,
      root: root as string | null,
      quality,
      confidence: confidence as number | null,
    });
    prevEnd = end;
  }
  if (Math.abs(prevEnd - durationSec) > EPS) {
    fail(`chords end at ${prevEnd}s but durationSec is ${durationSec}s (must cover [0, durationSec])`);
  }
  return out;
}

/** Validate arbitrary parsed JSON as an Analysis, or throw ContractError. */
export function validateAnalysis(input: unknown): Analysis {
  if (!isObj(input)) fail("Analysis must be an object");

  const contractVersion = reqStr(input, "contractVersion", "root");
  const major = Number.parseInt(contractVersion.split(".")[0] ?? "", 10);
  if (major !== CONTRACT_MAJOR) {
    fail(`unsupported contractVersion "${contractVersion}" (this build needs major ${CONTRACT_MAJOR})`);
  }

  const file = reqStr(input, "file", "root");
  const durationSec = reqNum(input, "durationSec", "root");
  const engine = validateEngine(input["engine"]);

  const caps = input["engineCapabilities"];
  if (
    !Array.isArray(caps) ||
    caps.some((c) => typeof c !== "string" || !CAPABILITIES.includes(c as EngineCapability))
  ) {
    fail(`"engineCapabilities" must be an array of known capability strings`);
  }

  const vocabulary = reqStr(input, "vocabulary", "root");
  if (vocabulary !== "triads") fail(`"vocabulary" must be "triads" at MVP, got "${vocabulary}"`);

  const key = validateKey(input["key"], "key");

  const kc = input["keyCandidates"];
  let keyCandidates: KeyCandidate[] | null;
  if (kc === undefined) fail(`missing required field "keyCandidates" (use null if not computed)`);
  else if (kc === null) keyCandidates = null;
  else if (!Array.isArray(kc)) fail(`"keyCandidates" must be array | null`);
  else keyCandidates = kc.map((k, i) => validateKey(k, `keyCandidates[${i}]`));

  if (input["chords"] === undefined) fail(`missing required field "chords"`);
  const chords = validateChords(input["chords"], durationSec);

  const beats = numArrayOrNull(input, "beats");
  const downbeats = numArrayOrNull(input, "downbeats");

  const ts = input["timeSignature"];
  let timeSignature: string | null;
  if (ts === undefined) fail(`missing required field "timeSignature" (use null if not computed)`);
  else if (ts === null) timeSignature = null;
  else if (typeof ts !== "string") fail(`"timeSignature" must be string | null`);
  else timeSignature = ts;

  return {
    contractVersion: contractVersion as ContractVersion,
    file,
    durationSec,
    engine,
    engineCapabilities: caps as EngineCapability[],
    vocabulary: "triads",
    key,
    keyCandidates,
    chords,
    beats,
    downbeats,
    timeSignature,
  };
}

// Local alias to keep the public return type readable without re-importing.
type ContractVersion = Analysis["contractVersion"];
