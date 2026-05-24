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
import { join } from "node:path";

import {
  EngineAbortError,
  EngineRunError,
  EngineUnavailableError,
  runEngineInfo,
} from "../core/engine";
import { analyzeWithCache } from "../core/cache";
import { resolveEngine } from "../core/engineResolve";
import { ContractError } from "../core/validate";
import { ERROR_KIND_EXIT, EXIT } from "../core/types";
import type { Analysis, EngineInfo, EngineName } from "../core/types";
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
  /** Bypass the result cache (read and write). */
  noCache?: boolean;
  /** Test seam: inject the analyze / engine-info argv prefixes (skips resolveEngine). */
  analyzeBase?: string[];
  engineInfoBase?: string[];
  isMock?: boolean;
  mockExplicit?: boolean;
}

/**
 * The engine to use when the user didn't pass `--engine`: btc iff it is actually installed (a
 * cheap engine-info probe), else librosa. btc is MIT, so there is no consent gate — if it's
 * installed it's the default. Returns the probed `EngineInfo` alongside the choice so the caller
 * can pass it to the cache as `expectedEngine` (the staleness check) without a second spawn.
 */
async function pickDefaultEngine(
  engineInfoBase: string[] | undefined,
  isMock: boolean,
): Promise<{ engine: EngineName; info?: EngineInfo }> {
  if (isMock || !engineInfoBase) return { engine: "librosa" };
  try {
    const info = await runEngineInfo({ command: [...engineInfoBase, "--engine", "btc"] });
    if (info.name === "btc") return { engine: "btc", info };
    return { engine: "librosa" };
  } catch {
    return { engine: "librosa" }; // not installed / probe failed → fall back to the clean core
  }
}

export async function cmdAnalyze(opts: AnalyzeOptions): Promise<number> {
  const io = opts.io ?? defaultIO;
  const json = opts.json ?? false;
  try {
    let base: string[];
    let engineInfoBase: string[] | undefined;
    let isMock: boolean;
    let mockExplicit: boolean;
    if (opts.analyzeBase) {
      base = opts.analyzeBase;
      engineInfoBase = opts.engineInfoBase;
      isMock = opts.isMock ?? false;
      mockExplicit = opts.mockExplicit ?? false;
    } else {
      const r = resolveEngine();
      base = r.analyzeBase;
      engineInfoBase = r.engineInfoBase;
      isMock = r.isMock;
      mockExplicit = r.mockExplicit;
    }
    gateMock(isMock, mockExplicit, json);

    let engine: EngineName;
    let expectedEngine: EngineInfo | undefined;
    if (opts.engine) {
      engine = opts.engine; // explicit choice; btc is MIT, so there is no consent gate
    } else {
      const picked = await pickDefaultEngine(engineInfoBase, isMock);
      engine = picked.engine;
      expectedEngine = picked.info; // present only when defaulted to btc
    }

    // analyzeWithCache appends --file/--json/--engine; a re-run of the same audio hits the cache
    // (skipped for the mock, whose data is fake). The CLI `json` flag only picks the rendering.
    const result = await analyzeWithCache(base, engine, opts.file, {
      noCache: opts.noCache,
      isMock,
      signal: opts.signal,
      expectedEngine,
    });
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

/** Result of `engine/selftest.py --engine X` — see its header. */
export interface SelftestResult {
  installed: boolean;
  working: boolean;
  detail: string;
}

/** Parse selftest.py's single JSON line; any non-JSON/garbage ⇒ a not-installed result. */
export function parseSelftest(line: string): SelftestResult {
  try {
    const o = JSON.parse(line) as Record<string, unknown>;
    return {
      installed: o["installed"] === true,
      working: o["working"] === true,
      detail: typeof o["detail"] === "string" ? o["detail"] : "",
    };
  } catch {
    return {
      installed: false,
      working: false,
      detail: firstLine(line) || "probe produced no output",
    };
  }
}

interface DoctorEngineRow {
  engine: EngineName;
  installed: boolean;
  working: boolean;
  license: string;
  isDefault: boolean;
  detail: string;
}

/** Render the per-engine doctor table: engine · installed · working · license · default. */
export function renderDoctorTable(rows: DoctorEngineRow[]): string {
  const header = ["engine", "installed", "working", "license", "default"];
  const body = rows.map((r) => [
    r.engine,
    r.installed ? "yes" : "no",
    r.working ? "yes" : "no",
    r.license,
    r.isDefault ? "✓" : "",
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...body.map((row) => row[i]!.length)),
  );
  const line = (cols: string[]) =>
    ("  " + cols.map((c, i) => c.padEnd(widths[i]!)).join("  ")).trimEnd();
  return [line(header), ...body.map(line)].join("\n");
}

export type RunSelftest = (engine: EngineName) => Promise<SelftestResult>;

// Static license map (the engines never report their own licence over the contract; this is
// metadata the frontend owns). `default` is decided at render time: btc if it works, else librosa.
const ENGINE_TIERS: { engine: EngineName; license: string }[] = [
  { engine: "librosa", license: "ISC" },
  { engine: "btc", license: "MIT" },
  { engine: "essentia", license: "AGPL-3.0" },
];

/** Default `runSelftest`: spawn selftest.py (array-form), parse its one JSON stdout line. */
async function defaultRunSelftest(
  python: string,
  selftestPy: string,
  engine: EngineName,
): Promise<SelftestResult> {
  try {
    const proc = Bun.spawn([python, selftestPy, "--engine", engine], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill(), 60_000); // btc's torch model load is slow
    const [out, errText] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    clearTimeout(timer);
    const last = out
      .trim()
      .split("\n")
      .filter((l) => l.trim())
      .pop();
    if (last) return parseSelftest(last);
    return {
      installed: false,
      working: false,
      detail: firstLine(errText.trim()) || "probe produced no output",
    };
  } catch (e) {
    return {
      installed: false,
      working: false,
      detail: e instanceof Error ? firstLine(e.message) : "probe failed",
    };
  }
}

export async function cmdDoctor(
  opts: { io?: CliIO; runSelftest?: RunSelftest } = {},
): Promise<number> {
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

  // Per-engine self-test: "working" means the engine's analyze() actually RAN on a tiny WAV,
  // not merely that the package imports. The three probes run concurrently (btc is slow to load).
  const selftestPy = join(r.engineDir, "selftest.py");
  const runSelftest: RunSelftest =
    opts.runSelftest ?? ((engine) => defaultRunSelftest(r.python, selftestPy, engine));
  const results = await Promise.all(ENGINE_TIERS.map((t) => runSelftest(t.engine)));
  const btcIdx = ENGINE_TIERS.findIndex((t) => t.engine === "btc");
  const defaultEngine: EngineName = results[btcIdx]?.working ? "btc" : "librosa";
  const engineRows: DoctorEngineRow[] = ENGINE_TIERS.map((t, i) => ({
    engine: t.engine,
    installed: results[i]!.installed,
    working: results[i]!.working,
    license: t.license,
    isDefault: t.engine === defaultEngine,
    detail: results[i]!.detail,
  }));

  const width = Math.max(...rows.map((row) => row.label.length));
  const out: string[] = ["chordTUI doctor", ""];
  for (const row of rows) {
    out.push(`  ${row.ok ? "✓" : "⚠"}  ${row.label.padEnd(width)}  ${row.detail}`);
  }
  out.push("");
  out.push("Engines (working = ran a processor on a test WAV):");
  out.push(renderDoctorTable(engineRows));
  out.push("");
  for (const er of engineRows) out.push(`    ${er.engine}: ${er.detail}`);
  out.push("");
  out.push(
    `Default accuracy engine: ${defaultEngine} ` +
      "(btc when installed + working, else the librosa preview/fallback).",
  );
  io.out(out.join("\n") + "\n");
  return EXIT.ok;
}

// ── setup ───────────────────────────────────────────────────────────
// Installs the license-clean librosa core via `uv sync`, and (the default) the opt-in btc
// accuracy tier into a SEPARATE venv (engine/.venv-btc: torch + librosa, running the vendored
// MIT BTC-ISMIR19 model). btc is MIT — no consent gate, just a one-time torch download, skippable
// with --no-btc. planSetup is a pure decision function (unit-testable without spawning `uv`); the
// imperative shell runs the installs through an injectable seam.

const ENGINE_CHOICES: readonly EngineName[] = ["librosa", "btc", "essentia"];

export interface SetupPlan {
  /** Engines to install, accuracy-low → high; always starts with librosa (the clean core). */
  installs: EngineName[];
  notices: string[];
  /** Non-empty ⇒ refuse before installing anything; print these and exit badInput. */
  errors: string[];
}

/**
 * Pure decision for `chord setup`. Parses its OWN flags (`--engine`, `--no-btc`) so they never
 * reach the router's generic parseFlags. Installs librosa (clean core) always, and btc (the MIT
 * accuracy default) unless `--no-btc` or `--engine librosa`. essentia is deferred (an error).
 */
export function planSetup(argv: string[]): SetupPlan {
  let engine: string | undefined;
  let noBtc = false;
  const errors: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--engine") {
      i += 1;
      engine = argv[i];
    } else if (a === "--no-btc") {
      noBtc = true;
    } else if (a !== undefined && a.startsWith("--")) {
      errors.push(`unknown option "${a}"`);
    }
    // positionals are ignored (setup takes none)
  }
  if (errors.length) return { installs: [], notices: [], errors };
  if (engine !== undefined && !ENGINE_CHOICES.includes(engine as EngineName)) {
    return { installs: [], notices: [], errors: [`unknown engine "${engine}" (choose librosa or btc)`] };
  }
  if (engine === "essentia") {
    return { installs: [], notices: [], errors: ["essentia engine not implemented yet (deferred)"] };
  }

  const installs: EngineName[] = ["librosa"];
  if (engine === "librosa" || noBtc) {
    return {
      installs,
      notices: ["librosa clean core only (no btc → triads only, no extended chords)."],
      errors: [],
    };
  }
  installs.push("btc");
  return {
    installs,
    notices: ["btc (MIT, ~80% accuracy + extended chords) installs into engine/.venv-btc — a one-time torch download."],
    errors: [],
  };
}

export interface SetupOptions {
  io?: CliIO;
  /** Setup's own argv (after the `setup` command word). */
  argv?: string[];
  /** Test seam: run an install command, returning its exit code. Default = array-form Bun.spawn. */
  runInstall?: (cmd: string[]) => Promise<number>;
}

async function defaultRunInstall(cmd: string[]): Promise<number> {
  // Array-form (never sh -c); stream the installer's output straight through.
  const proc = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit", stdin: "inherit" });
  return await proc.exited;
}

export async function cmdSetup(opts: SetupOptions = {}): Promise<number> {
  const io = opts.io ?? defaultIO;
  const argv = opts.argv ?? [];
  const r = resolveEngine();

  io.out("chordTUI setup\n\n");
  const plan = planSetup(argv);
  if (plan.errors.length) {
    for (const e of plan.errors) io.err(`Error: ${e}\n`);
    return EXIT.badInput;
  }
  for (const n of plan.notices) io.out(`${n}\n`);

  const runInstall = opts.runInstall ?? defaultRunInstall;

  io.out("\nInstalling the librosa clean core (uv sync)…\n");
  let code = await runInstall(["uv", "sync", "--project", r.engineDir, "--no-dev"]);
  if (code !== 0) {
    io.err("Clean-core install failed (uv sync). See output above.\n");
    return EXIT.analysisFailed;
  }

  if (plan.installs.includes("btc")) {
    // btc gets its OWN venv (torch needs py3.11/numpy2; kept out of the clean-core py3.9 venv).
    const btcVenv = join(r.engineDir, ".venv-btc");
    io.out("\nInstalling the btc accuracy engine (torch — a one-time few-hundred-MB download)…\n");
    code = await runInstall(["uv", "venv", "--python", "3.11", btcVenv]);
    if (code === 0) {
      code = await runInstall([
        "uv", "pip", "install", "--python", btcVenv,
        "torch", "numpy", "librosa", "pyyaml", "mir_eval", "soundfile", "audioread",
      ]);
    }
    if (code !== 0) {
      io.err("btc install failed (see output above; details in docs/probe-matrix.md §7).\n");
      return EXIT.analysisFailed;
    }
  }

  io.out(`\nDone. Installed: ${plan.installs.join(", ")}.\n`);
  if (plan.installs.includes("btc")) {
    io.out("btc is now the default accuracy engine. Run `chord doctor` to confirm.\n");
  }
  return EXIT.ok;
}
