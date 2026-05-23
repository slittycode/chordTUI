// src/cli/commands.ts — the `chord` CLI commands, layered on the engine contract.
//
// Each command returns a numeric exit code (the router in index.tsx assigns it to
// process.exitCode). I/O goes through an injectable `CliIO` rather than console.* — a
// deliberate deviation from tempo's commands so the commands are unit-testable by capturing
// `out`/`err` into buffers (see tests/ts/cli.test.ts). engine resolution is also injectable
// (the `*Base` / isMock options) so tests drive the real mock sidecar without touching env.
//
// Mock policy (PLAN.md §6): the bundled mock sidecar is contract-conformant but emits FAKE
// data. We run it only when it's safe to show fake results — an explicit $CHORDTUI_SIDECAR,
// or an interactive TTY without --json. Piped/--json with no real engine refuses (exit 3),
// so sample chords never leak into a script or a bug report.

import { existsSync } from "node:fs";

import {
  EngineAbortError,
  EngineRunError,
  EngineUnavailableError,
  runEngine,
  runEngineInfo,
} from "../core/engine";
import { resolveEngine } from "../core/engineResolve";
import { ContractError } from "../core/validate";
import { ERROR_KIND_EXIT, EXIT } from "../core/types";
import type { Analysis, EngineName } from "../core/types";
import {
  collapseProgression,
  confidenceMeaning,
  formatChordLabel,
  formatKey,
  romanNumeral,
} from "../core/music";

export interface CliIO {
  out(s: string): void;
  err(s: string): void;
}

export const defaultIO: CliIO = {
  out: (s) => {
    process.stdout.write(s);
  },
  err: (s) => {
    process.stderr.write(s);
  },
};

// Engine resolution (resolveEngine / ResolvedEngine) lives in ../core/engineResolve so both
// the CLI and the TUI's useAnalysis hook can share it. Re-exported here is unnecessary — the
// only external consumer (tests) drives the commands via the injected `*Base` seam.

/** Refuse to run the mock when it isn't safe to show fake data (see Mock policy above). */
function gateMock(isMock: boolean, mockExplicit: boolean, json: boolean): void {
  if (!isMock) return;
  const allow = mockExplicit || (process.stdout.isTTY === true && !json);
  if (!allow) {
    throw new EngineUnavailableError(
      "no analysis engine installed — only the bundled mock is available, and it is " +
        "suppressed for non-interactive / --json output. Run `chord setup` to install an " +
        "engine, or `chord doctor` to diagnose.",
    );
  }
}

/** Map a thrown engine/contract error to an exit code, printing a human message. */
function errorToExit(e: unknown, io: CliIO): number {
  // Subclasses first — EngineUnavailableError/EngineAbortError extend EngineRunError.
  if (e instanceof EngineUnavailableError) {
    io.err(`Engine unavailable: ${e.message}\n`);
    return EXIT.engineUnavailable;
  }
  if (e instanceof EngineAbortError) {
    io.err("Cancelled.\n");
    return 130; // SIGINT convention
  }
  if (e instanceof ContractError) {
    io.err(`Engine returned malformed output: ${e.message}\n`);
    return EXIT.analysisFailed;
  }
  if (e instanceof EngineRunError) {
    io.err(`${e.message}\n`); // timeout / spawn / other process-level failure
    return EXIT.analysisFailed;
  }
  io.err(`Unexpected error: ${e instanceof Error ? e.message : String(e)}\n`);
  return EXIT.analysisFailed;
}

// ── analyze ─────────────────────────────────────────────────────────

export interface AnalyzeOptions {
  file: string;
  engine?: EngineName;
  json?: boolean;
  io?: CliIO;
  signal?: AbortSignal;
  /** Test seam: inject the analyze argv prefix (skips resolveEngine). */
  analyzeBase?: string[];
  isMock?: boolean;
  mockExplicit?: boolean;
}

export async function cmdAnalyze(opts: AnalyzeOptions): Promise<number> {
  const io = opts.io ?? defaultIO;
  const json = opts.json ?? false;
  try {
    let base: string[];
    let isMock: boolean;
    let mockExplicit: boolean;
    if (opts.analyzeBase) {
      base = opts.analyzeBase;
      isMock = opts.isMock ?? false;
      mockExplicit = opts.mockExplicit ?? false;
    } else {
      const r = resolveEngine();
      base = r.analyzeBase;
      isMock = r.isMock;
      mockExplicit = r.mockExplicit;
    }
    gateMock(isMock, mockExplicit, json);

    // Always pass --json to the sidecar (its stdout is one JSON doc per the contract); the
    // CLI's own `json` flag only decides raw-vs-summary rendering.
    const argv = [
      ...base,
      "--file",
      opts.file,
      "--json",
      ...(opts.engine ? ["--engine", opts.engine] : []),
    ];
    const result = await runEngine({ command: argv, signal: opts.signal });
    if (result.kind === "error") {
      const { kind, detail, hint } = result.value;
      io.err(`Analysis failed: ${detail}${hint ? ` (${hint})` : ""}\n`);
      return ERROR_KIND_EXIT[kind];
    }
    if (json) {
      io.out(JSON.stringify(result.value, null, 2) + "\n");
      return EXIT.ok;
    }
    io.out(renderSummary(result.value, isMock));
    return EXIT.ok;
  } catch (e) {
    return errorToExit(e, io);
  }
}

function renderSummary(a: Analysis, isMock: boolean): string {
  const lines: string[] = [];
  if (isMock) {
    lines.push("[MOCK] sample output — no real engine installed (run `chord setup`)");
  }
  lines.push(`File:     ${a.file}`);
  lines.push(`Duration: ${a.durationSec.toFixed(1)}s`);
  lines.push(`Engine:   ${a.engine.name} ${a.engine.version} (${a.engine.license})`);
  lines.push(
    `Key:      ${formatKey(a.key)} — confidence ${a.key.confidence.toFixed(2)} ` +
      `(${confidenceMeaning(a.engine.confidenceKind)})`,
  );

  const cells = collapseProgression(a.chords).map((run) => {
    const label = formatChordLabel(run, a.key);
    const rn = romanNumeral(run.root, run.quality, a.key);
    return rn ? `${label} (${rn})` : label;
  });
  const MAX = 32;
  const body = cells.length
    ? cells.slice(0, MAX).join(" → ") +
      (cells.length > MAX ? ` … (+${cells.length - MAX} more)` : "")
    : "(none)";
  lines.push(`Chords:   ${body}`);
  return lines.join("\n") + "\n";
}

// ── engine-info ─────────────────────────────────────────────────────

export interface EngineInfoOptions {
  engine?: EngineName;
  json?: boolean;
  io?: CliIO;
  engineInfoBase?: string[];
  isMock?: boolean;
  mockExplicit?: boolean;
}

export async function cmdEngineInfo(opts: EngineInfoOptions): Promise<number> {
  const io = opts.io ?? defaultIO;
  const json = opts.json ?? false;
  try {
    let base: string[];
    let isMock: boolean;
    let mockExplicit: boolean;
    if (opts.engineInfoBase) {
      base = opts.engineInfoBase;
      isMock = opts.isMock ?? false;
      mockExplicit = opts.mockExplicit ?? false;
    } else {
      const r = resolveEngine();
      base = r.engineInfoBase;
      isMock = r.isMock;
      mockExplicit = r.mockExplicit;
    }
    // Same gate as analyze, so a piped/--json engine-info can't leak fake engine metadata.
    gateMock(isMock, mockExplicit, json);

    const argv = [...base, ...(opts.engine ? ["--engine", opts.engine] : [])];
    const info = await runEngineInfo({ command: argv });
    if (json) {
      io.out(JSON.stringify(info, null, 2) + "\n");
      return EXIT.ok;
    }
    const lines: string[] = [];
    if (isMock) lines.push("[MOCK] engine-info from the bundled mock (run `chord setup`)");
    lines.push(`Engine:       ${info.name} ${info.version} (${info.license})`);
    lines.push(`Contract:     ${info.contractVersion}`);
    lines.push(`Confidence:   ${info.confidenceKind} — ${confidenceMeaning(info.confidenceKind)}`);
    lines.push(`Capabilities: ${info.capabilities.join(", ") || "(none)"}`);
    const models = Object.entries(info.modelVersions);
    lines.push(
      `Models:       ${
        models.length ? models.map(([k, v]) => `${k}=${v}`).join(", ") : "(none — rule-based)"
      }`,
    );
    io.out(lines.join("\n") + "\n");
    return EXIT.ok;
  } catch (e) {
    return errorToExit(e, io);
  }
}

// ── doctor ──────────────────────────────────────────────────────────

interface ProbeResult {
  ok: boolean;
  detail: string;
}

function firstLine(s: string): string {
  return s.split("\n")[0] ?? "";
}

/** Run a short, side-effect-free probe command; never throws. */
function probeCommand(cmd: string[], timeoutMs = 8000): ProbeResult {
  try {
    const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
    if (p.success) {
      const out = firstLine(p.stdout.toString().trim()) || firstLine(p.stderr.toString().trim());
      return { ok: true, detail: out };
    }
    if (p.signalCode) return { ok: false, detail: `killed by ${p.signalCode} (timed out?)` };
    const err = firstLine(p.stderr.toString().trim()) || firstLine(p.stdout.toString().trim());
    return { ok: false, detail: err || "command failed" };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? firstLine(e.message) : "not found" };
  }
}

interface DoctorRow {
  label: string;
  ok: boolean;
  detail: string;
}

export async function cmdDoctor(opts: { io?: CliIO } = {}): Promise<number> {
  const io = opts.io ?? defaultIO;
  const r = resolveEngine();
  const rows: DoctorRow[] = [];

  rows.push({ label: "engine dir", ok: existsSync(r.engineDir), detail: r.engineDir });

  const py = probeCommand([r.python, "--version"]);
  rows.push({
    label: "python",
    ok: py.ok,
    detail: py.ok ? `${r.python} (${py.detail})` : `${r.python} — ${py.detail}`,
  });

  const ff = probeCommand(["ffmpeg", "-version"]);
  rows.push({
    label: "ffmpeg",
    ok: ff.ok,
    detail: ff.ok ? ff.detail : "not found (needed to decode mp3/m4a)",
  });

  const lib = probeCommand([r.python, "-c", "import librosa; print(librosa.__version__)"]);
  rows.push({
    label: "librosa",
    ok: lib.ok,
    detail: lib.ok ? lib.detail : "not installed (run `chord setup`)",
  });

  const mad = probeCommand([r.python, "-c", "import madmom; print(madmom.__version__)"]);
  rows.push({
    label: "madmom",
    ok: mad.ok,
    detail: mad.ok ? `${mad.detail} (CC-BY-NC-SA models)` : "not installed (optional; ~80% accuracy)",
  });

  // End-to-end protocol probe: only ✓ when a REAL engine answers the contract. The mock
  // always answers, so reporting ✓ for it would falsely claim a working engine.
  let proto: DoctorRow;
  if (r.isMock) {
    proto = {
      label: "engine (protocol)",
      ok: false,
      detail: "bundled mock only — no real engine (run `chord setup`)",
    };
  } else {
    try {
      const info = await runEngineInfo({ command: r.engineInfoBase, timeoutMs: 8000 });
      proto = {
        label: "engine (protocol)",
        ok: true,
        detail: `${info.name} speaks contract ${info.contractVersion}`,
      };
    } catch (e) {
      proto = {
        label: "engine (protocol)",
        ok: false,
        detail: e instanceof Error ? firstLine(e.message) : "failed",
      };
    }
  }
  rows.push(proto);

  const width = Math.max(...rows.map((row) => row.label.length));
  const out: string[] = ["chordTUI doctor", ""];
  for (const row of rows) {
    out.push(`  ${row.ok ? "✓" : "⚠"}  ${row.label.padEnd(width)}  ${row.detail}`);
  }
  out.push("");
  out.push("Default accuracy engine: madmom when installed, else the librosa preview/fallback.");
  io.out(out.join("\n") + "\n");
  return EXIT.ok;
}

// ── setup (placeholder) ─────────────────────────────────────────────

export function cmdSetup(opts: { io?: CliIO } = {}): number {
  const io = opts.io ?? defaultIO;
  io.out(
    [
      "`chord setup` is not implemented yet.",
      "",
      "It will create the Python venv and install the analysis engines:",
      "  • librosa  (ISC)            always — the clean base, instant preview + fallback",
      "  • madmom   (BSD code;       opt-in for ~80% accuracy; one-time CC-BY-NC-SA",
      "              CC-BY-NC-SA                NonCommercial consent, defaulting to yes",
      "              models)",
      "  • essentia (AGPL-3.0)       separate explicit opt-in alternative",
      "",
      "Until then, the bundled mock sidecar provides contract-conformant sample output.",
      "See PLAN.md §6.",
    ].join("\n") + "\n",
  );
  return EXIT.ok;
}
