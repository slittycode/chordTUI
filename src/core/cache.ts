// src/core/cache.ts — per-engine result cache, keyed on audio content (PLAN.md §5/§6).
//
// A re-run of the same file with the same engine returns the stored Analysis instead of
// re-spawning Python. The key is sha256(file bytes) + engine, so editing/replacing the audio
// invalidates it automatically; the entry is re-validated on read (a wrong-major or corrupt
// entry is ignored → recompute). The cache is shared by the CLI (cmdAnalyze) and the TUI
// (makeDefaultDriver) through the `analyzeWithCache` helper, so a re-run is instant in both —
// and in the TUI it flows through the existing reducer path with no new action.
//
// Honesty: the bundled MOCK is never cached (its data is fake). $CHORDTUI_CACHE_DIR overrides
// the location for tests; every read/write is best-effort and never fails a run.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { runEngine } from "./engine";
import type { RunEngineResult } from "./engine";
import type { Analysis, EngineEvent, EngineInfo, EngineName } from "./types";
import { validateAnalysis } from "./validate";

function cacheDir(): string {
  return process.env["CHORDTUI_CACHE_DIR"] || join(homedir(), ".cache", "chordtui", "results");
}

/** sha256 of the file's bytes; throws if the file can't be read (callers treat that as a miss). */
function fileHash(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function entryPath(file: string, engine: EngineName): string {
  return join(cacheDir(), `${fileHash(file)}__${engine}.json`);
}

/** True iff two modelVersions maps have identical keys and values. */
function sameModelVersions(a: Record<string, string>, b: Record<string, string>): boolean {
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  return ak.every((k) => a[k] === b[k]);
}

/**
 * Return a cached, re-validated Analysis for (file, engine), or null on any miss/error.
 *
 * `expectedEngine` (when supplied) adds a staleness check: the cached entry's engine.version and
 * modelVersions must match the currently-installed engine, else the entry is treated as a miss
 * (recompute). A contract-major match alone isn't enough — an engine upgrade or model swap can
 * change the output for the same audio. Callers pass it only where they already hold the engine
 * info (no extra spawn); without it the check is contract-major-only, as before.
 */
export function cacheGet(
  file: string,
  engine: EngineName,
  expectedEngine?: EngineInfo,
): Analysis | null {
  try {
    const path = entryPath(file, engine);
    if (!existsSync(path)) return null;
    const analysis = validateAnalysis(JSON.parse(readFileSync(path, "utf8")));
    if (expectedEngine) {
      if (analysis.engine.version !== expectedEngine.version) return null;
      if (!sameModelVersions(analysis.engine.modelVersions, expectedEngine.modelVersions)) {
        return null;
      }
    }
    // The stored path is whatever ran first; reflect the path actually queried now.
    analysis.file = file;
    return analysis;
  } catch {
    return null;
  }
}

/** Store an Analysis for (file, engine). Best-effort; never throws. */
export function cachePut(file: string, engine: EngineName, analysis: Analysis): void {
  try {
    const dir = cacheDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(entryPath(file, engine), JSON.stringify(analysis));
  } catch {
    /* cache writes are best-effort */
  }
}

export interface CachedAnalyzeOptions {
  /** Skip the cache entirely (read and write). */
  noCache?: boolean;
  /** The resolved sidecar is the bundled mock → never cache its fake output. */
  isMock?: boolean;
  /** Installed engine info for the cache staleness check (see cacheGet). */
  expectedEngine?: EngineInfo;
  signal?: AbortSignal;
  onEvent?: (e: EngineEvent) => void;
  timeoutMs?: number;
}

/**
 * Run `analyze` for (engine, file) through the cache: a hit returns immediately; a miss spawns
 * the sidecar and stores a successful Analysis. A structured `{ error }` result is returned but
 * never cached. `analyzeBase` is the per-sidecar argv prefix from engineResolve.
 */
export async function analyzeWithCache(
  analyzeBase: string[],
  engine: EngineName,
  file: string,
  opts: CachedAnalyzeOptions = {},
): Promise<RunEngineResult> {
  const useCache = !opts.noCache && !opts.isMock;
  if (useCache) {
    const hit = cacheGet(file, engine, opts.expectedEngine);
    if (hit) return { kind: "analysis", value: hit };
  }
  const command = [...analyzeBase, "--file", file, "--json", "--engine", engine];
  const result = await runEngine({
    command,
    signal: opts.signal,
    onEvent: opts.onEvent,
    timeoutMs: opts.timeoutMs,
  });
  if (useCache && result.kind === "analysis") cachePut(file, engine, result.value);
  return result;
}
