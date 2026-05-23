// src/core/engineResolve.ts — where (and how) to invoke the Python analysis sidecar.
//
// Resolved ONCE per call (no per-analysis `uv run`). Lives in core/ (not cli/) so both the
// CLI commands and the TUI's useAnalysis hook can depend on it without inverting the layering
// (PLAN.md §5 names this file). Reads `process.env` + the filesystem eagerly each call, so
// callers that want a single snapshot (e.g. the hook) should memoize the result.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ResolvedEngine {
  engineDir: string;
  python: string;
  /** True when the resolved sidecar is the bundled mock (fake data). */
  isMock: boolean;
  /** True when the user explicitly pointed at a sidecar via $CHORDTUI_SIDECAR. */
  mockExplicit: boolean;
  analyzeBase: string[];
  engineInfoBase: string[];
}

function resolveEngineDir(): string {
  const fromEnv = process.env["CHORDTUI_ENGINE_DIR"];
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const userDir = join(homedir(), ".local", "share", "chordtui", "engine");
  if (existsSync(userDir)) return userDir;
  return join(import.meta.dir, "..", "..", "engine"); // dev fallback: repo engine/
}

function resolvePython(engineDir: string): string {
  const fromEnv = process.env["CHORDTUI_PYTHON"];
  if (fromEnv) return fromEnv;
  const venv = join(engineDir, ".venv", "bin", "python");
  return existsSync(venv) ? venv : "python3";
}

/**
 * Resolve where (and how) to invoke the analysis sidecar. The bases are per-command because
 * the mock is one flat-argparse file with a positional `command` (`analyze`/`engine-info`),
 * whereas the real engine (PLAN.md §5) is two scripts. The Python path is resolved ONCE here.
 */
export function resolveEngine(): ResolvedEngine {
  const engineDir = resolveEngineDir();
  const python = resolvePython(engineDir);

  const explicit = process.env["CHORDTUI_SIDECAR"];
  if (explicit) {
    return {
      engineDir,
      python,
      isMock: true,
      mockExplicit: true,
      analyzeBase: [python, explicit, "analyze"],
      engineInfoBase: [python, explicit, "engine-info"],
    };
  }

  const analyzePy = join(engineDir, "analyze.py");
  const engineInfoPy = join(engineDir, "engine_info.py");
  if (existsSync(analyzePy) && existsSync(engineInfoPy)) {
    return {
      engineDir,
      python,
      isMock: false,
      mockExplicit: false,
      analyzeBase: [python, analyzePy],
      engineInfoBase: [python, engineInfoPy],
    };
  }

  const mock = join(engineDir, "mock_sidecar.py");
  return {
    engineDir,
    python,
    isMock: true,
    mockExplicit: false,
    analyzeBase: [python, mock, "analyze"],
    engineInfoBase: [python, mock, "engine-info"],
  };
}
