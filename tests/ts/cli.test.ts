// tests/ts/cli.test.ts — CLI commands driven against the real mock sidecar.
//
// Each command takes an injectable CliIO (captured into buffers here) and an injected engine
// base, so we exercise the full spawn → validate → render path without touching env or a TTY.
// Under `bun test`, process.stdout.isTTY is falsy, so the mock gate is deterministic.

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cmdAnalyze,
  cmdDoctor,
  cmdEngineInfo,
  cmdSetup,
  parseSelftest,
  renderDoctorTable,
  type CliIO,
  type RunSelftest,
  type SelftestResult,
} from "../../src/cli/commands";
import { hasMadmomConsent, setMadmomConsent } from "../../src/core/consent";
import { validateAnalysis } from "../../src/core/validate";
import { ERROR_KIND_EXIT } from "../../src/core/types";
import type { EngineName } from "../../src/core/types";

const ANALYZE = ["python3", "engine/mock_sidecar.py", "analyze"];
const ENGINE_INFO = ["python3", "engine/mock_sidecar.py", "engine-info"];

function captureIO(): { io: CliIO; out: () => string; err: () => string } {
  let out = "";
  let err = "";
  return {
    io: {
      out: (s) => {
        out += s;
      },
      err: (s) => {
        err += s;
      },
    },
    out: () => out,
    err: () => err,
  };
}

// ── analyze ─────────────────────────────────────────────────────────

test("analyze --json emits a valid sparse Analysis, exit 0", async () => {
  const c = captureIO();
  const code = await cmdAnalyze({ file: "x.wav", json: true, io: c.io, analyzeBase: ANALYZE });
  expect(code).toBe(0);
  const a = validateAnalysis(JSON.parse(c.out()));
  expect(a.engine.name).toBe("librosa");
  expect(a.engineCapabilities).toEqual(["key", "chords"]);
});

test("analyze --json emits a valid full Analysis, exit 0", async () => {
  const c = captureIO();
  const code = await cmdAnalyze({
    file: "x.wav",
    json: true,
    io: c.io,
    analyzeBase: [...ANALYZE, "--payload", "full"],
  });
  expect(code).toBe(0);
  const a = validateAnalysis(JSON.parse(c.out()));
  expect(a.engine.name).toBe("madmom");
  expect(a.keyCandidates?.length).toBe(3);
});

test("analyze summary prints key, engine, and progression with roman numerals", async () => {
  const c = captureIO();
  const code = await cmdAnalyze({ file: "x.wav", io: c.io, analyzeBase: ANALYZE });
  expect(code).toBe(0);
  const out = c.out();
  expect(out).toContain("C major");
  expect(out).toContain("librosa");
  expect(out).toContain("C (I) → F (IV) → G (V) → C (I)");
});

test("analyze error scenario → ERROR_KIND_EXIT.decode_failed + detail printed", async () => {
  const c = captureIO();
  const code = await cmdAnalyze({
    file: "x.wav",
    io: c.io,
    analyzeBase: [...ANALYZE, "--scenario", "error"],
  });
  expect(code).toBe(ERROR_KIND_EXIT.decode_failed); // 4
  expect(c.err()).toContain("mock decode failure");
});

test("analyze surfaces an exit-3 sidecar as engine-unavailable (exit 3)", async () => {
  const c = captureIO();
  const code = await cmdAnalyze({
    file: "x.wav",
    io: c.io,
    analyzeBase: ["python3", "-c", "import sys;sys.exit(3)"],
  });
  expect(code).toBe(3);
});

// ── default engine selection (consent + availability) ───────────────

async function withConfigDir<T>(fn: () => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "chordtui-pick-"));
  const prev = process.env["CHORDTUI_CONFIG_DIR"];
  process.env["CHORDTUI_CONFIG_DIR"] = dir;
  try {
    return await fn(); // MUST await: the env/dir teardown below has to follow the async body,
    // not fire when the callback merely returns its promise (else post-await reads see no dir).
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (prev === undefined) delete process.env["CHORDTUI_CONFIG_DIR"];
    else process.env["CHORDTUI_CONFIG_DIR"] = prev;
  }
}

test("default engine selects madmom when consented AND available", async () => {
  await withConfigDir(async () => {
    setMadmomConsent();
    const c = captureIO();
    const code = await cmdAnalyze({
      file: "x.wav", // missing → cache no-ops; the engine is what we assert
      json: true,
      io: c.io,
      analyzeBase: [...ANALYZE, "--payload", "full"], // mock "full" reports engine madmom
      engineInfoBase: [...ENGINE_INFO, "--payload", "full"], // probe sees madmom available
    });
    expect(code).toBe(0);
    expect(JSON.parse(c.out()).engine.name).toBe("madmom");
  });
});

test("default engine falls back to librosa without consent (no probe)", async () => {
  await withConfigDir(async () => {
    const c = captureIO();
    const code = await cmdAnalyze({
      file: "x.wav",
      json: true,
      io: c.io,
      analyzeBase: ANALYZE, // mock "sparse" reports engine librosa
      engineInfoBase: [...ENGINE_INFO, "--payload", "full"], // would say madmom, but unconsented → never probed
    });
    expect(code).toBe(0);
    expect(JSON.parse(c.out()).engine.name).toBe("librosa");
  });
});

test("--engine madmom prints the NC notice on first consent, not after (Fix 6)", async () => {
  await withConfigDir(async () => {
    const base = [...ANALYZE, "--payload", "full"]; // mock reports engine madmom
    const c1 = captureIO();
    expect(
      await cmdAnalyze({ file: "x.wav", json: true, io: c1.io, engine: "madmom", analyzeBase: base }),
    ).toBe(0);
    expect(c1.err()).toContain("CC-BY-NC-SA"); // first explicit madmom use → notice + consent
    expect(hasMadmomConsent()).toBe(true);
    const c2 = captureIO();
    expect(
      await cmdAnalyze({ file: "x.wav", json: true, io: c2.io, engine: "madmom", analyzeBase: base }),
    ).toBe(0);
    expect(c2.err()).not.toContain("CC-BY-NC-SA"); // already consented → not repeated
  });
});

// ── mock gating (Decision 1) ────────────────────────────────────────

test("analyze refuses the mock under --json with no explicit override (exit 3)", async () => {
  const c = captureIO();
  const code = await cmdAnalyze({
    file: "x.wav",
    json: true,
    io: c.io,
    analyzeBase: ANALYZE,
    isMock: true,
    mockExplicit: false,
  });
  expect(code).toBe(3);
});

test("analyze allows an explicit mock under --json (exit 0)", async () => {
  const c = captureIO();
  const code = await cmdAnalyze({
    file: "x.wav",
    json: true,
    io: c.io,
    analyzeBase: ANALYZE,
    isMock: true,
    mockExplicit: true,
  });
  expect(code).toBe(0);
});

// ── engine-info ─────────────────────────────────────────────────────

test("engine-info summary prints name + capabilities", async () => {
  const c = captureIO();
  const code = await cmdEngineInfo({ io: c.io, engineInfoBase: ENGINE_INFO });
  expect(code).toBe(0);
  expect(c.out()).toContain("librosa");
  expect(c.out()).toContain("key, chords");
});

test("engine-info --json validates and exits 0", async () => {
  const c = captureIO();
  const code = await cmdEngineInfo({ json: true, io: c.io, engineInfoBase: ENGINE_INFO });
  expect(code).toBe(0);
  const info = JSON.parse(c.out());
  expect(info.name).toBe("librosa");
  expect(info.contractVersion).toMatch(/^1\./);
});

test("engine-info applies the same mock gate as analyze (exit 3 under --json)", async () => {
  const c = captureIO();
  const code = await cmdEngineInfo({
    json: true,
    io: c.io,
    engineInfoBase: ENGINE_INFO,
    isMock: true,
    mockExplicit: false,
  });
  expect(code).toBe(3);
});

// ── doctor / setup ──────────────────────────────────────────────────

test("parseSelftest reads installed/working/failed lines", () => {
  expect(parseSelftest('{"engine":"librosa","installed":true,"working":true,"detail":"detected key C major"}')).toEqual(
    { installed: true, working: true, detail: "detected key C major" },
  );
  expect(parseSelftest('{"engine":"madmom","installed":true,"working":false,"detail":"RuntimeError: boom"}')).toEqual(
    { installed: true, working: false, detail: "RuntimeError: boom" },
  );
  expect(parseSelftest('{"engine":"essentia","installed":false,"working":false,"detail":"no engine module (deferred)"}')).toEqual(
    { installed: false, working: false, detail: "no engine module (deferred)" },
  );
  // garbage (e.g. a traceback) ⇒ not installed, never throws
  const broken = parseSelftest("Traceback (most recent call last):");
  expect(broken.installed).toBe(false);
  expect(broken.working).toBe(false);
});

test("renderDoctorTable shows all five columns and marks the default", () => {
  const table = renderDoctorTable([
    { engine: "librosa", installed: true, working: true, license: "ISC", isDefault: false, detail: "" },
    { engine: "madmom", installed: true, working: true, license: "CC-BY-NC-SA-4.0", isDefault: true, detail: "" },
    { engine: "essentia", installed: false, working: false, license: "AGPL-3.0", isDefault: false, detail: "" },
  ]);
  for (const col of ["engine", "installed", "working", "license", "default"]) {
    expect(table).toContain(col);
  }
  expect(table).toContain("librosa");
  expect(table).toContain("CC-BY-NC-SA-4.0");
  expect(table).toContain("AGPL-3.0");
  expect(table).toContain("✓"); // the madmom (default) row
});

test("doctor prints the per-engine table; default is madmom when it works", async () => {
  const fakeSelftest: RunSelftest = async (engine: EngineName): Promise<SelftestResult> => {
    if (engine === "librosa") return { installed: true, working: true, detail: "detected key C major" };
    if (engine === "madmom") return { installed: true, working: true, detail: "detected key C major" };
    return { installed: false, working: false, detail: "no engine module (deferred)" };
  };
  const c = captureIO();
  const code = await cmdDoctor({ io: c.io, runSelftest: fakeSelftest });
  expect(code).toBe(0);
  const out = c.out();
  expect(out).toContain("chordTUI doctor");
  expect(out).not.toContain("engine (protocol)"); // that row was removed
  expect(out).toContain("madmom");
  expect(out).toContain("CC-BY-NC-SA-4.0");
  expect(out).toContain("Default accuracy engine: madmom");
});

test("doctor default falls back to librosa when madmom can't run", async () => {
  const fakeSelftest: RunSelftest = async (engine: EngineName): Promise<SelftestResult> => {
    if (engine === "librosa") return { installed: true, working: true, detail: "detected key C major" };
    if (engine === "madmom") return { installed: false, working: false, detail: "madmom package not installed" };
    return { installed: false, working: false, detail: "no engine module (deferred)" };
  };
  const c = captureIO();
  const code = await cmdDoctor({ io: c.io, runSelftest: fakeSelftest });
  expect(code).toBe(0);
  expect(c.out()).toContain("Default accuracy engine: librosa");
});

function fakeInstaller(): { runInstall: (cmd: string[]) => Promise<number>; cmds: () => string[][] } {
  const cmds: string[][] = [];
  return {
    runInstall: async (cmd: string[]) => {
      cmds.push(cmd);
      return 0;
    },
    cmds: () => cmds,
  };
}

test("setup (non-TTY, no flags) installs only the clean core and never touches madmom", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chordtui-setup-"));
  const prev = process.env["CHORDTUI_CONFIG_DIR"];
  process.env["CHORDTUI_CONFIG_DIR"] = dir;
  try {
    const c = captureIO();
    const inst = fakeInstaller();
    const code = await cmdSetup({ io: c.io, argv: [], isTTY: false, runInstall: inst.runInstall });
    expect(code).toBe(0);
    expect(c.out()).toContain("chordTUI setup");
    expect(c.out()).toContain("--accept-noncommercial"); // the hint to add madmom
    const cmds = inst.cmds();
    expect(cmds.length).toBe(1); // only `uv sync`
    expect(cmds[0]).toEqual(expect.arrayContaining(["uv", "sync", "--no-dev"]));
    expect(cmds.some((cmd) => cmd.includes("madmom==0.16.1"))).toBe(false);
    expect(hasMadmomConsent()).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (prev === undefined) delete process.env["CHORDTUI_CONFIG_DIR"];
    else process.env["CHORDTUI_CONFIG_DIR"] = prev;
  }
});

test("setup --accept-noncommercial installs madmom (after the core) and records consent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chordtui-setup-"));
  const prev = process.env["CHORDTUI_CONFIG_DIR"];
  process.env["CHORDTUI_CONFIG_DIR"] = dir;
  try {
    const c = captureIO();
    const inst = fakeInstaller();
    const code = await cmdSetup({
      io: c.io,
      argv: ["--accept-noncommercial"],
      isTTY: false,
      runInstall: inst.runInstall,
    });
    expect(code).toBe(0);
    expect(c.out()).toContain("CC-BY-NC-SA");
    expect(hasMadmomConsent()).toBe(true);
    const cmds = inst.cmds();
    expect(cmds[0]).toEqual(expect.arrayContaining(["uv", "sync", "--no-dev"])); // core first
    expect(cmds.some((cmd) => cmd.includes("madmom==0.16.1"))).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (prev === undefined) delete process.env["CHORDTUI_CONFIG_DIR"];
    else process.env["CHORDTUI_CONFIG_DIR"] = prev;
  }
});

test("setup --engine madmom (non-TTY, no consent) refuses without installing", async () => {
  const c = captureIO();
  const inst = fakeInstaller();
  const code = await cmdSetup({
    io: c.io,
    argv: ["--engine", "madmom"],
    isTTY: false,
    runInstall: inst.runInstall,
  });
  expect(code).not.toBe(0); // badInput
  expect(c.err()).toContain("--accept-noncommercial");
  expect(inst.cmds().length).toBe(0); // nothing installed
});
