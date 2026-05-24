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
import { hasMadmomConsent, setMadmomConsent } from "../core/consent";
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
 * The engine to use when the user didn't pass `--engine`: madmom iff the user has accepted its
 * NonCommercial licence AND it is actually installed (a cheap engine-info probe), else librosa.
 * The probe is skipped entirely until consent exists, so the common path adds zero overhead.
 *
 * Returns the probed `EngineInfo` alongside the choice when it defaulted to madmom, so the caller
 * can pass it to the cache as `expectedEngine` (the staleness check) without a second spawn.
 */
async function pickDefaultEngine(
  engineInfoBase: string[] | undefined,
  isMock: boolean,
): Promise<{ engine: EngineName; info?: EngineInfo }> {
  if (isMock || !engineInfoBase || !hasMadmomConsent()) return { engine: "librosa" };
  try {
    const info = await runEngineInfo({ command: [...engineInfoBase, "--engine", "madmom"] });
    if (info.name === "madmom") return { engine: "madmom", info };
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
      engine = opts.engine;
      if (engine === "madmom" && !hasMadmomConsent()) {
        // An explicit `--engine madmom` IS consent (PLAN.md §6) — but record it loudly, not
        // silently: print the NonCommercial notice once, only on this first opt-in (Fix 6).
        setMadmomConsent();
        io.err(`${MADMOM_NC_NOTICE}\n`);
      }
    } else {
      const picked = await pickDefaultEngine(engineInfoBase, isMock);
      engine = picked.engine;
      expectedEngine = picked.info; // present only when defaulted to madmom
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
// metadata the frontend owns). `default` is decided at render time: madmom if it works, else librosa.
const ENGINE_TIERS: { engine: EngineName; license: string }[] = [
  { engine: "librosa", license: "ISC" },
  { engine: "madmom", license: "CC-BY-NC-SA-4.0" },
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
    const timer = setTimeout(() => proc.kill(), 60_000); // madmom's CNN model load is slow
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
  // not merely that the package imports. The three probes run concurrently (madmom is slow).
  const selftestPy = join(r.engineDir, "selftest.py");
  const runSelftest: RunSelftest =
    opts.runSelftest ?? ((engine) => defaultRunSelftest(r.python, selftestPy, engine));
  const results = await Promise.all(ENGINE_TIERS.map((t) => runSelftest(t.engine)));
  const madmomIdx = ENGINE_TIERS.findIndex((t) => t.engine === "madmom");
  const defaultEngine: EngineName = results[madmomIdx]?.working ? "madmom" : "librosa";
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
      "(madmom when installed + working, else the librosa preview/fallback).",
  );
  io.out(out.join("\n") + "\n");
  return EXIT.ok;
}

// ── setup ───────────────────────────────────────────────────────────
// Installs the license-clean librosa core via `uv sync`, and — only with explicit consent
// (flag or an interactive yes) — the opt-in madmom accuracy tier whose pretrained models are
// CC-BY-NC-SA NonCommercial. The decision is a pure function (planSetup) so it's unit-testable
// without spawning `uv`; the imperative shell runs the installs through an injectable seam.

/** The one-line NonCommercial notice for madmom's models — shared by setup and analyze (Fix 6). */
export const MADMOM_NC_NOTICE =
  "Note: madmom's pretrained models are licensed CC-BY-NC-SA 4.0 (NonCommercial) — " +
  "free for non-commercial use only.";

const ENGINE_CHOICES: readonly EngineName[] = ["librosa", "madmom", "essentia"];

export interface SetupPlan {
  /** Engines to install, accuracy-low → high; always starts with librosa (the clean core). */
  installs: EngineName[];
  /** Ask interactively (default-yes) before adding madmom (TTY, no explicit consent flag). */
  promptMadmom: boolean;
  notices: string[];
  /** Non-empty ⇒ refuse before installing anything; print these and exit badInput. */
  errors: string[];
}

/**
 * Pure decision for `chord setup`. Parses its OWN flags (`--engine`, `--no-madmom`,
 * `--accept-noncommercial`) so they never reach the router's generic parseFlags. madmom is
 * NEVER scheduled for install without explicit consent (a flag, or — via promptMadmom — an
 * interactive yes). essentia is deferred (an error, not an install).
 */
export function planSetup(argv: string[], ctx: { isTTY: boolean }): SetupPlan {
  let engine: string | undefined;
  let noMadmom = false;
  let acceptNC = false;
  const errors: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--engine") {
      i += 1;
      engine = argv[i];
    } else if (a === "--no-madmom") {
      noMadmom = true;
    } else if (a === "--accept-noncommercial") {
      acceptNC = true;
    } else if (a !== undefined && a.startsWith("--")) {
      errors.push(`unknown option "${a}"`);
    }
    // positionals are ignored (setup takes none)
  }
  const refuse = (msg: string): SetupPlan => ({
    installs: [],
    promptMadmom: false,
    notices: [],
    errors: [msg],
  });
  if (errors.length) return { installs: [], promptMadmom: false, notices: [], errors };
  if (engine !== undefined && !ENGINE_CHOICES.includes(engine as EngineName)) {
    return refuse(`unknown engine "${engine}" (choose librosa, madmom, or essentia)`);
  }
  if (engine === "essentia") return refuse("essentia engine not implemented yet (deferred)");

  const installs: EngineName[] = ["librosa"];
  const notices: string[] = [];

  // librosa-only: explicit, or via --no-madmom; no prompt either way.
  if (engine === "librosa" || (engine === undefined && noMadmom)) {
    return { installs, promptMadmom: false, notices, errors: [] };
  }

  // Consent already given via flag → schedule madmom now.
  if (acceptNC) {
    installs.push("madmom");
    notices.push(MADMOM_NC_NOTICE);
    return { installs, promptMadmom: false, notices, errors: [] };
  }

  // No flag consent. An explicit `--engine madmom` with no TTY to prompt must refuse (never silent).
  if (engine === "madmom" && !ctx.isTTY) {
    return refuse(
      "--engine madmom needs consent: re-run with --accept-noncommercial " +
        "(madmom's models are CC-BY-NC-SA NonCommercial)",
    );
  }

  // TTY → ask before adding madmom (default-yes). Non-TTY default flow → librosa + a hint.
  if (ctx.isTTY) return { installs, promptMadmom: true, notices, errors: [] };
  notices.push("re-run with --accept-noncommercial to also install madmom (~80%-accuracy NonCommercial tier).");
  return { installs, promptMadmom: false, notices, errors: [] };
}

export interface SetupOptions {
  io?: CliIO;
  /** Setup's own argv (after the `setup` command word). */
  argv?: string[];
  /** Whether stdout is an interactive terminal (drives the consent prompt). */
  isTTY?: boolean;
  /** Test seam: ask for madmom consent. Default = node:readline/promises, default-yes. */
  confirm?: (question: string) => Promise<boolean>;
  /** Test seam: run an install command, returning its exit code. Default = array-form Bun.spawn. */
  runInstall?: (cmd: string[]) => Promise<number>;
}

async function defaultConfirm(question: string): Promise<boolean> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = (await rl.question(question)).trim().toLowerCase();
    return ans === "" || ans === "y" || ans === "yes"; // default-yes
  } finally {
    rl.close();
  }
}

async function defaultRunInstall(cmd: string[]): Promise<number> {
  // Array-form (never sh -c); stream the installer's output straight through.
  const proc = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit", stdin: "inherit" });
  return await proc.exited;
}

export async function cmdSetup(opts: SetupOptions = {}): Promise<number> {
  const io = opts.io ?? defaultIO;
  const argv = opts.argv ?? [];
  const isTTY = opts.isTTY ?? false;
  const r = resolveEngine();

  io.out("chordTUI setup\n\n");
  const plan = planSetup(argv, { isTTY });
  if (plan.errors.length) {
    for (const e of plan.errors) io.err(`Error: ${e}\n`);
    return EXIT.badInput;
  }
  for (const n of plan.notices) io.out(`${n}\n`);

  const installs = [...plan.installs];
  if (plan.promptMadmom) {
    const confirm = opts.confirm ?? defaultConfirm;
    io.out(`\n${MADMOM_NC_NOTICE}\n`);
    const yes = await confirm("Install the madmom accuracy engine (~80%, NonCommercial)? [Y/n] ");
    if (yes) {
      setMadmomConsent();
      io.out("Recorded madmom NonCommercial (CC-BY-NC-SA) consent.\n");
      installs.push("madmom");
    } else {
      io.out("Skipping madmom; using the librosa clean core only.\n");
    }
  } else if (installs.includes("madmom")) {
    // Consent came in via --accept-noncommercial — persist it before installing.
    setMadmomConsent();
  }

  const runInstall = opts.runInstall ?? defaultRunInstall;
  // The venv may not exist yet, so compute its python explicitly (resolveEngine falls back to
  // system python3 until the venv is created by the uv sync below).
  const venvPython = join(r.engineDir, ".venv", "bin", "python");

  io.out("\nInstalling the librosa clean core (uv sync)…\n");
  let code = await runInstall(["uv", "sync", "--project", r.engineDir, "--no-dev"]);
  if (code !== 0) {
    io.err("Clean-core install failed (uv sync). See output above.\n");
    return EXIT.analysisFailed;
  }

  if (installs.includes("madmom")) {
    io.out("Installing madmom (validated recipe; the model build can take a few minutes)…\n");
    code = await runInstall([
      "uv", "pip", "install", "--python", venvPython, "cython<3", "setuptools<60", "wheel", "pip",
    ]);
    if (code === 0) {
      code = await runInstall([
        "uv", "pip", "install", "--python", venvPython, "--no-build-isolation", "madmom==0.16.1",
      ]);
    }
    if (code !== 0) {
      io.err("madmom install failed (see output above; recipe in docs/probe-matrix.md §1).\n");
      return EXIT.analysisFailed;
    }
  }

  io.out(`\nDone. Installed: ${installs.join(", ")}.\n`);
  if (installs.includes("madmom")) {
    io.out("madmom is now the default accuracy engine. Run `chord doctor` to confirm.\n");
  }
  return EXIT.ok;
}
