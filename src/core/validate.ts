// src/core/validate.ts — runtime validation of engine output.
//
// TS types erase at runtime, so engine.ts must validate parsed JSON before trusting
// it. We hand-roll the checks (the contract is small and stable) rather than pull in a
// JSON-schema dependency. Python validates the same payloads against engine/schema.json
// + engine/engine-info.schema.json; the round-trip tests assert both sides agree —
// including unknown-key rejection (strict, matching `additionalProperties: false`) and
// the gap-free chord invariant that JSON Schema cannot express.

import type {
  Analysis,
  ConfidenceKind,
  ContractVersion,
  EngineCapability,
  EngineError,
  EngineInfo,
  EngineInfoResponse,
  EngineName,
  KeyCandidate,
  KeyResult,
} from "./types";

const CONTRACT_MAJOR_RE = /^1\.\d+\.\d+$/;
const EPS = 1e-6;

const CONFIDENCE_KINDS: ConfidenceKind[] = ["posterior", "correlation", "heuristic"];
const ENGINE_NAMES: EngineName[] = ["librosa", "madmom", "essentia", "btc"];
const ERROR_KINDS: EngineError["kind"][] = [
  "bad_input",
  "decode_failed",
  "engine_unavailable",
  "internal",
];
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

/** Strict: reject any property not in `allowed` (mirrors schema additionalProperties:false). */
function noExtra(o: Record<string, unknown>, allowed: string[], where: string): void {
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k)) fail(`${where}: unexpected property "${k}"`);
  }
}

function reqNum(o: Record<string, unknown>, k: string, where: string): number {
  const v = o[k];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    fail(`${where}: expected finite number at "${k}", got ${JSON.stringify(v)}`);
  }
  return v;
}

/** Confidence must be a probability/score in [0, 1]. */
function unitInterval(v: number, where: string): number {
  if (v < 0 || v > 1) fail(`${where}: confidence ${v} out of range [0, 1]`);
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
  noExtra(v, ["tonic", "mode", "confidence"], where);
  const tonic = reqStr(v, "tonic", where);
  const mode = reqStr(v, "mode", where);
  if (mode !== "major" && mode !== "minor") fail(`${where}.mode must be "major" | "minor"`);
  const confidence = unitInterval(reqNum(v, "confidence", where), where);
  return { tonic, mode, confidence };
}

/** The 5 EngineInfo fields, without unknown-key checks (callers add the right noExtra set). */
function engineFields(v: Record<string, unknown>, where: string): EngineInfo {
  const name = reqStr(v, "name", where) as EngineName;
  if (!ENGINE_NAMES.includes(name)) fail(`${where}.name invalid: ${name}`);
  const confidenceKind = reqStr(v, "confidenceKind", where) as ConfidenceKind;
  if (!CONFIDENCE_KINDS.includes(confidenceKind)) {
    fail(`${where}.confidenceKind invalid: ${confidenceKind}`);
  }
  const mv = v["modelVersions"];
  if (!isObj(mv) || Object.values(mv).some((x) => typeof x !== "string")) {
    fail(`${where}.modelVersions must be Record<string, string>`);
  }
  return {
    name,
    version: reqStr(v, "version", where),
    license: reqStr(v, "license", where),
    modelVersions: mv as Record<string, string>,
    confidenceKind,
  };
}

function validateEngine(v: unknown): EngineInfo {
  if (!isObj(v)) fail(`"engine" must be an object`);
  noExtra(v, ["name", "version", "license", "modelVersions", "confidenceKind"], "engine");
  return engineFields(v, "engine");
}

function validateCapabilities(v: unknown, where: string): EngineCapability[] {
  if (
    !Array.isArray(v) ||
    v.some((c) => typeof c !== "string" || !CAPABILITIES.includes(c as EngineCapability))
  ) {
    fail(`${where} must be an array of known capability strings`);
  }
  if (new Set(v as string[]).size !== (v as string[]).length) {
    fail(`${where} contains duplicate capabilities`);
  }
  return v as EngineCapability[];
}

function validateContractVersion(v: string, where: string): ContractVersion {
  if (!CONTRACT_MAJOR_RE.test(v)) {
    fail(`${where}: unsupported contractVersion "${v}" (this build needs major 1, form 1.x.y)`);
  }
  return v as ContractVersion;
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
    noExtra(s, ["start", "end", "label", "root", "quality", "confidence"], where);
    const start = reqNum(s, "start", where);
    const end = reqNum(s, "end", where);
    const label = reqStr(s, "label", where);
    const quality = reqStr(s, "quality", where);

    const root = s["root"];
    if (root !== null && typeof root !== "string") fail(`${where}.root must be string | null`);

    const confidence = s["confidence"];
    if (confidence !== null) {
      if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
        fail(`${where}.confidence must be a finite number | null`);
      }
      if (confidence < 0 || confidence > 1) {
        fail(`${where}.confidence ${confidence} out of range [0, 1]`);
      }
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
  noExtra(
    input,
    [
      "contractVersion",
      "file",
      "durationSec",
      "engine",
      "engineCapabilities",
      "vocabulary",
      "key",
      "keyCandidates",
      "chords",
      "beats",
      "downbeats",
      "timeSignature",
    ],
    "Analysis",
  );

  const contractVersion = validateContractVersion(reqStr(input, "contractVersion", "root"), "root");
  const file = reqStr(input, "file", "root");
  const durationSec = reqNum(input, "durationSec", "root");
  if (durationSec < 0) fail(`"durationSec" must be >= 0, got ${durationSec}`);
  const engine = validateEngine(input["engine"]);
  const engineCapabilities = validateCapabilities(input["engineCapabilities"], "engineCapabilities");

  const vocabulary = reqStr(input, "vocabulary", "root") as "triads" | "extended";
  if (vocabulary !== "triads" && vocabulary !== "extended") {
    fail(`"vocabulary" must be "triads" or "extended", got "${vocabulary}"`);
  }

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
    contractVersion,
    file,
    durationSec,
    engine,
    engineCapabilities,
    vocabulary,
    key,
    keyCandidates,
    chords,
    beats,
    downbeats,
    timeSignature,
  };
}

/** Validate the `engine-info` response (cheap capability/version probe). */
export function validateEngineInfo(input: unknown): EngineInfoResponse {
  if (!isObj(input)) fail("engine-info must be an object");
  noExtra(
    input,
    ["name", "version", "license", "modelVersions", "confidenceKind", "contractVersion", "capabilities"],
    "engine-info",
  );
  const base = engineFields(input, "engine-info");
  const contractVersion = validateContractVersion(
    reqStr(input, "contractVersion", "engine-info"),
    "engine-info",
  );
  const capabilities = validateCapabilities(input["capabilities"], "engine-info.capabilities");
  return { ...base, contractVersion, capabilities };
}

/** Validate an EngineError envelope (the `.error` value, not the wrapper). */
export function validateEngineError(input: unknown): EngineError {
  if (!isObj(input)) fail("error must be an object");
  noExtra(input, ["kind", "detail", "hint"], "error");
  const kind = reqStr(input, "kind", "error") as EngineError["kind"];
  if (!ERROR_KINDS.includes(kind)) fail(`error.kind invalid: ${kind}`);
  const detail = reqStr(input, "detail", "error");
  const hint = input["hint"];
  if (hint !== undefined && typeof hint !== "string") fail(`error.hint must be string | undefined`);
  return hint === undefined ? { kind, detail } : { kind, detail, hint };
}

/**
 * Discriminate the stdout union: an Analysis, or an `{ error: EngineError }` envelope.
 * This is the single seam engine.ts uses so the discriminator is never reinvented.
 */
export function parseEngineOutput(
  input: unknown,
): { kind: "analysis"; value: Analysis } | { kind: "error"; value: EngineError } {
  if (isObj(input) && "error" in input) {
    noExtra(input, ["error"], "engine output"); // strict: exactly { error: ... }, nothing else
    return { kind: "error", value: validateEngineError(input["error"]) };
  }
  return { kind: "analysis", value: validateAnalysis(input) };
}
