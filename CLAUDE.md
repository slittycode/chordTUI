# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

chordTUI is a macOS terminal tool: point it at an audio file (MP3/FLAC/WAV) and it reports the
song's **key**, its **chords over time**, and the **chord progression** (triads + key at MVP).
**`PLAN.md` is the authoritative design doc** — it covers the IPC protocol (§3/§4), the phased
build plan (§7), accuracy targets and the verification gates (§9), and licensing rationale.
Read it before non-trivial changes; don't duplicate its detail here (a second source of truth
drifts).

## Commands

```bash
# Frontend (TypeScript / Bun) — run from repo root
bun test                                     # all TS tests
bun test tests/ts/music.test.ts              # one TS test file
bun test -t "roman numeral"                  # one TS test by name
bun run typecheck                            # tsc --noEmit (must be clean)
bun run dev                                   # watch-run src/index.tsx
bun run src/index.tsx analyze <file.wav>     # run the CLI directly (binary name: `chord`)

# Python engine — also run from repo root (uv resolves the engine/ project)
uv run --project engine pytest               # all Python tests
uv run --project engine pytest tests/py/test_librosa_engine.py -k "test_key_is_c_major"
uv run --project engine ruff check engine/   # lint
```

`uv run --project engine pytest` works from the repo root because `engine/pyproject.toml` sets
`testpaths = ["../tests/py"]` — the test files live *outside* the `engine/` package dir, in
`tests/py/`. Those tests run the real librosa engine end-to-end (sys.executable is the py3.9
venv that has librosa), synthesizing fixture WAVs at runtime (no copyrighted audio committed).

## Architecture

**Polyglot split coupled only by a versioned JSON contract.** A TypeScript/Bun + OpenTUI
frontend drives a Python analysis sidecar over `Bun.spawn`. The contract is the *sole* coupling,
so the two halves are independently testable and a future engine can drop in without frontend
changes. Read the file headers of `src/core/types.ts` and `src/core/engine.ts` — they document
their own invariants thoroughly.

### The contract is a three-way lockstep (biggest edit hazard)

These four must move together, or the round-trip tests (`tests/ts/contract.test.ts`,
`tests/py/test_schema.py`) fail:

1. `src/core/types.ts` — the TS types (the canonical shape).
2. `src/core/validate.ts` — a **hand-rolled** runtime validator (no zod/ajv). Enforces strict
   "no unexpected property" checks mirroring JSON Schema `additionalProperties: false`.
3. `engine/schema.json` — JSON Schema for the `Analysis` payload.
4. `engine/engine-info.schema.json` — JSON Schema for the cheap `engine-info` probe.

Change one field → change all four. Both sides enforce strict unknown-key rejection.

### IPC protocol (see PLAN.md §4 for the full spec)

- **Invocation:** array-form `Bun.spawn`, never `sh -c` (the file path is untrusted input).
- **stdout:** exactly one JSON document — an `Analysis` or `{ error: EngineError }`. Buffered
  fully (capped, never truncated), then parsed + validated.
- **stderr:** NDJSON, one progress/log event per line, streamed incrementally.
- **exit codes:** 0 ok · 2 bad input · 3 engine-unavailable (no stdout → route to `doctor`) ·
  4 analysis/internal. `src/core/engine.ts` owns the cancel ladder (AbortSignal/timeout →
  SIGTERM → grace → SIGKILL); it mirrors `~/code/projects/tempo/src/daemon.ts`, deliberately
  **not** tempo's `executor.ts`.

### Tiered engines, capability-gated UI

Three engines speak the *same* contract, differentiated only by `engineCapabilities[]` and
`confidenceKind` — **never by sniffing the engine name**: librosa (ISC, always installs;
preview + fallback), madmom (BSD code, **CC-BY-NC-SA models**; opt-in, the ~80%-accuracy
default), essentia (AGPL; opt-in). A UI panel renders **iff** its capability is present; a
nullable field that is `null` means "engine couldn't compute" → the sub-feature is removed,
**never faked**. A *missing* required field is a malformed-output error, not a null.

### Pure music theory stays TS-side

`src/core/music.ts` derives enharmonic spelling and **in-key** roman numerals from
`(key, root, quality)` — these are never sent over the wire. Out-of-key / unknown chords get
**no numeral** (omit, never invent). Pure functions, unit-tested without a renderer.

## Invariants & gotchas

1. **`chords[]` is gap-free and contiguous** over `[0, durationSec]`: `chords[i].end ===
   chords[i+1].start`. Silence is an explicit `"N"` (no-chord) segment, never a gap. The
   validator enforces this (JSON Schema can't).
2. **`process.exitCode = …`, never `process.exit()`** in `src/index.tsx` — `process.exit()` can
   drop a buffered `--json` stdout write before it flushes.
3. **Python producers serialize with `allow_nan=False`** (`engine/protocol.py:dumps`) — a bare
   `NaN`/`Infinity` token is invalid JSON for Bun and slips past schema numeric checks; fail loud.
4. **Mock-sidecar gate** (`src/cli/commands.ts:gateMock`): with no real engine, the bundled mock
   emits contract-conformant **fake** data. It runs only in an interactive TTY (no `--json`) or
   when `$CHORDTUI_SIDECAR` is set; piped / `--json` refuses with exit 3 so sample chords never
   leak into a script or bug report. Tests bypass this via the injected `analyzeBase` /
   `engineInfoBase` seam, not env vars.
5. **Python is pinned for madmom compat, not preference:** `requires-python = ">=3.9,<3.10"`,
   `numpy<1.24`, `scipy<1.13`. madmom/essentia are **not** uv extras — they're scripted installs
   documented as comments in `engine/pyproject.toml`, so default `uv sync` stays license-clean
   (zero NC/AGPL). See `docs/probe-matrix.md` for the validated madmom recipe.
6. **Contract version is major-1** (`1.x.y`); the frontend rejects a mismatched major.

## Current state vs PLAN.md

The plan describes the full system; the repo is partway through it. Notably:

1. **Built:** the contract (types/validate/schemas), `engine/mock_sidecar.py`, the librosa
   engine (`engine/analyze.py`, `engine/engine_info.py`, `engine/protocol.py`,
   `engine/engines/librosa_engine.py`), the `engine.ts` spawn/validate seam, the CLI
   (`analyze` / `engine-info` / `doctor` in `src/cli/commands.ts`), and the **interactive
   TUI** — no-arg `chord` mounts an OpenTUI React app: `src/hooks/useAnalysis.ts` (the
   preview→upgrade state machine + a pure reducer), `src/core/panels.ts` (capability gating),
   and `src/components/` (App, AnalysisView, Header, FilePicker, KeyPanel, ChordTimeline,
   ProgressionPanel, StatusBar, ErrorBoundary).
2. **Not built yet** (don't go hunting for these): `chord setup` is a placeholder, and the
   madmom and essentia engine modules don't exist (analyze.py returns `engine_unavailable` for
   them) — so the TUI's accuracy "upgrade" always falls back to the librosa preview for now.
3. **Drift to note:** `resolveEngine` now lives in `src/core/engineResolve.ts` (extracted from
   `commands.ts`, shared by the CLI and the hook). PLAN.md §5's `src/core/cache.ts` still does
   not exist — results are not cached yet.
