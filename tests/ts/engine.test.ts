// tests/ts/engine.test.ts — runEngine() against the real mock sidecar (Bun.spawn).
//
// Covers the protocol contract end-to-end: success/slow/garbage/error from the mock's
// scenarios, the cancel ladder (timeout→SIGTERM→SIGKILL and external-abort), the
// engine-unavailable (exit 3 → doctor) branch, the stdout cap, and the static guarantees
// the plan calls for (array-form spawn, no `sh -c`, an AbortSignal wired in).
//
// Some cases that the mock intentionally doesn't model (a bad contractVersion, exit 3, an
// oversized stdout, an orphan-after-SIGKILL) are exercised by spawning a one-off
// `python3 -c …` — injecting the exact payload/exit/behavior without bloating the mock.

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import {
  runEngine,
  EngineAbortError,
  EngineSpawnError,
  EngineTimeoutError,
  EngineUnavailableError,
} from "../../src/core/engine";
import { ContractError } from "../../src/core/validate";

const MOCK = "engine/mock_sidecar.py";
const mockCmd = (...args: string[]) => ["python3", MOCK, ...args];
const py = (code: string) => ["python3", "-c", code];

/** Run the mock synchronously to grab a known-good payload for mutation. */
function mockStdout(...args: string[]): string {
  return Bun.spawnSync(["python3", MOCK, ...args]).stdout.toString();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── happy paths ─────────────────────────────────────────────────────

test("success (sparse): returns a validated librosa analysis", async () => {
  const r = await runEngine({ command: mockCmd("analyze", "--payload", "sparse") });
  expect(r.kind).toBe("analysis");
  if (r.kind === "analysis") {
    expect(r.value.engine.name).toBe("librosa");
    expect(r.value.engineCapabilities).toEqual(["key", "chords"]);
    expect(r.value.keyCandidates).toBeNull();
  }
});

test("success (full): returns the rich madmom analysis", async () => {
  const r = await runEngine({ command: mockCmd("analyze", "--payload", "full") });
  expect(r.kind).toBe("analysis");
  if (r.kind === "analysis") {
    expect(r.value.engine.name).toBe("madmom");
    expect(r.value.keyCandidates?.length).toBe(3);
    expect(r.value.timeSignature).toBe("4/4");
  }
});

test("streams the ordered progress stages on stderr (slow scenario)", async () => {
  const stages: string[] = [];
  const r = await runEngine({
    command: mockCmd("analyze", "--scenario", "slow"),
    onEvent: (e) => {
      if (e.type === "progress") stages.push(e.stage);
    },
  });
  expect(r.kind).toBe("analysis");
  expect(stages).toEqual([
    "decode",
    "features",
    "beat-track",
    "chord-decode",
    "key-detect",
    "assemble",
  ]);
});

// ── structured engine error (a result, not a throw) ─────────────────

test("error scenario: returns a structured { error } envelope despite nonzero exit", async () => {
  const r = await runEngine({ command: mockCmd("analyze", "--scenario", "error") });
  expect(r.kind).toBe("error");
  if (r.kind === "error") {
    expect(r.value.kind).toBe("decode_failed");
    expect(r.value.hint).toBeDefined();
  }
});

// ── malformed / unparseable output ──────────────────────────────────

test("garbage stdout → ContractError (the run is an error, not partial success)", async () => {
  await expect(
    runEngine({ command: mockCmd("analyze", "--scenario", "garbage") }),
  ).rejects.toBeInstanceOf(ContractError);
});

test("contractVersion major mismatch → ContractError", async () => {
  const payload = JSON.parse(mockStdout("analyze", "--payload", "sparse"));
  payload.contractVersion = "2.0.0";
  await expect(
    runEngine({
      command: py("import os,sys;sys.stdout.write(os.environ['PAYLOAD'])"),
      env: { ...process.env, PAYLOAD: JSON.stringify(payload) },
    }),
  ).rejects.toBeInstanceOf(ContractError);
});

// ── cancel ladder ───────────────────────────────────────────────────

test("hang: timeout escalates SIGTERM→SIGKILL → EngineTimeoutError", async () => {
  const start = Date.now();
  await expect(
    runEngine({ command: mockCmd("analyze", "--scenario", "hang"), timeoutMs: 150, graceMs: 100 }),
  ).rejects.toBeInstanceOf(EngineTimeoutError);
  // SIGTERM is ignored by `hang`; we must have escalated to SIGKILL and returned promptly.
  expect(Date.now() - start).toBeLessThan(3000);
});

test("external AbortSignal cancels mid-run → EngineAbortError, keeping progress so far", async () => {
  const ac = new AbortController();
  const stages: string[] = [];
  const p = runEngine({
    command: mockCmd("analyze", "--scenario", "partial-killed"),
    signal: ac.signal,
    onEvent: (e) => {
      if (e.type === "progress") stages.push(e.stage);
    },
  });
  // Wait until its three pre-block stages have arrived, then cancel (robust to CI jitter).
  for (let i = 0; i < 50 && stages.length < 3; i++) await sleep(20);
  ac.abort();
  await expect(p).rejects.toBeInstanceOf(EngineAbortError);
  expect(stages).toEqual(["decode", "features", "beat-track"]);
});

test("a pre-aborted signal cancels promptly, without running the full analysis", async () => {
  const ac = new AbortController();
  ac.abort();
  const t0 = Date.now();
  await expect(
    runEngine({ command: mockCmd("analyze", "--scenario", "slow"), signal: ac.signal }),
  ).rejects.toBeInstanceOf(EngineAbortError);
  expect(Date.now() - t0).toBeLessThan(1000);
});

test("kills the child on timeout — no orphan survives the grace window", async () => {
  // Ignores SIGTERM and reports its own PID; only SIGKILL can reap it.
  const code =
    "import os,sys,signal,time,json;" +
    "signal.signal(signal.SIGTERM,signal.SIG_IGN);" +
    "sys.stderr.write(json.dumps({'type':'log','level':'info','msg':'pid='+str(os.getpid())})+chr(10));" +
    "sys.stderr.flush();" +
    "time.sleep(3600)";
  let pid = 0;
  await expect(
    runEngine({
      command: py(code),
      timeoutMs: 150,
      graceMs: 100,
      onEvent: (e) => {
        if (e.type === "log") {
          const m = e.msg.match(/pid=(\d+)/);
          if (m) pid = Number(m[1]);
        }
      },
    }),
  ).rejects.toBeInstanceOf(EngineTimeoutError);

  expect(pid).toBeGreaterThan(0);
  let alive = true;
  for (let i = 0; i < 60 && alive; i++) {
    try {
      process.kill(pid, 0); // throws once the process is gone
      await sleep(50);
    } catch {
      alive = false;
    }
  }
  expect(alive).toBe(false);
});

// ── engine unavailable (exit 3 → doctor) ────────────────────────────

test("exit 3 with no stdout → EngineUnavailableError", async () => {
  await expect(
    runEngine({ command: py("import sys;sys.exit(3)") }),
  ).rejects.toBeInstanceOf(EngineUnavailableError);
});

test("exit 3 with an { error } envelope → EngineUnavailableError carrying the detail", async () => {
  const code =
    "import sys,json;" +
    "sys.stdout.write(json.dumps({'error':{'kind':'engine_unavailable','detail':'madmom not installed','hint':'run chord setup'}}));" +
    "sys.exit(3)";
  await expect(runEngine({ command: py(code) })).rejects.toThrow(/madmom not installed/);
});

// ── process-level guards ────────────────────────────────────────────

test("empty command → EngineSpawnError", async () => {
  await expect(runEngine({ command: [] })).rejects.toBeInstanceOf(EngineSpawnError);
});

test("stdout past the cap errors out (no silent truncation)", async () => {
  await expect(
    runEngine({ command: py("import sys;sys.stdout.write('x'*5000)"), maxStdoutBytes: 1000 }),
  ).rejects.toBeInstanceOf(EngineSpawnError);
});

test("a malformed stderr line is surfaced as a warn log, never aborting the run", async () => {
  const logs: string[] = [];
  // Emit one junk stderr line, then a valid Analysis (from $PAYLOAD) on stdout.
  const payload = mockStdout("analyze", "--payload", "sparse");
  const r = await runEngine({
    command: py(
      "import os,sys;sys.stderr.write('not json at all'+chr(10));sys.stderr.flush();sys.stdout.write(os.environ['PAYLOAD'])",
    ),
    env: { ...process.env, PAYLOAD: payload },
    onEvent: (e) => {
      if (e.type === "log") logs.push(e.msg);
    },
  });
  expect(r.kind).toBe("analysis");
  expect(logs.some((m) => m.includes("unparseable stderr line"))).toBe(true);
});

// ── static guarantees the plan requires ─────────────────────────────

test("engine.ts is array-form spawn (no shell) and wires an AbortSignal", () => {
  const src = readFileSync("src/core/engine.ts", "utf8");
  // No shell invocation: no `Bun.$`, no `"sh"`/`"-c"` argv tokens (the prose comment's
  // "sh -c" is fine — we check for the quoted tokens that only appear in real shell use).
  expect(src).not.toContain("Bun.$");
  expect(src).not.toContain('"sh"');
  expect(src).not.toContain('"-c"');
  expect(src).toContain("AbortController");
  expect(src).toContain("AbortSignal");
  expect(src).toContain("SIGTERM");
  expect(src).toContain("SIGKILL");
});
