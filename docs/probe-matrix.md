# Phase-0 Probe Matrix

Empirical go/no-go results that the plan's Phase-0 gate depends on.
Machine: macOS (Apple Silicon, arm64). Recorded as probes are run.

## 1. madmom install + run — ✅ PASS (2026-05-22)

The load-bearing de-risk: does the default accuracy engine install **and run its
models on real audio** on this machine? (Not a bare `import` — a processor on a WAV.)

**Environment that worked:**
- Python **3.9.6** (Apple CommandLineTools), isolated `uv` venv at `engine/.venv`
- `cython==0.29.37` (<3), `numpy==1.23.5` (<1.24, retains `np.float`), `scipy==1.12.0` (<1.13)
- `setuptools==59.8.0` (<60), `wheel`, built with `--no-build-isolation`
- `madmom==0.16.1` from the **PyPI sdist** (bundles the model files — no git submodule fetch needed)
- ffmpeg 8.1.1 present (not exercised by the WAV path, needed later for mp3/flac)

**Install recipe (reproducible):**
```sh
uv venv --python 3.9 engine/.venv
uv pip install --python engine/.venv "cython<3" "numpy<1.24" "scipy<1.13" "setuptools<60" wheel pip
uv pip install --python engine/.venv --no-build-isolation "madmom==0.16.1"
```

**Result** (`engine/probe_madmom.py` on a synthesized I–IV–V–I in C major):
- Chords: `C:maj → F:maj → G:maj → C:maj` — exact match.
- Key: `C major` — exact match.
- `PROBE RESULT: PASS`

**Caveat:** this is *synthesized* clean-sine audio (the easy case). It proves
install + model load + runtime + basic correctness, **not** real-world accuracy.
Real-recording accuracy is measured later by the §9 accuracy gate on the fixture set.

**Implication for the plan:** madmom-as-v1-default is viable on this machine. The
"<70% install on strangers' machines" risk does not apply (personal, single target).

## 2. librosa engine — ✅ SMOKE PASS (2026-05-23) · ☐ accuracy gate pending

**Smoke (install + run + contract-valid), NOT the §9 accuracy gate.** Proves the librosa
engine (`engine/engines/librosa_engine.py` behind `engine/analyze.py`) installs, runs, and
emits valid contract JSON on synthesized audio — it does **not** measure real-recording
accuracy (the ≥75% key / ≥55% chord floor of §9, which needs the annotated fixture set).

**Environment:** macOS-arm64, `engine/.venv` (Py 3.9.6), librosa 0.10.2.post1, numpy 1.23.5,
scipy 1.12.0, soundfile 0.13.1.

**Result** (synth I–IV–V–I in C major, the `probe_madmom.py` fixture):
- Key: `C major`, confidence 0.97 (clamped KS correlation) — exact match.
- Chords: `C → F → G → C`, gap-free over [0, 6.4], `{C,F,G}`-maj coverage ≈ 100% (after the
  boundary-flicker despeckle) — exact match.
- stdout one valid `Analysis` (jsonschema + `validate.ts`); stderr emits all six NDJSON
  stages in order; `allow_nan=False` holds. Error paths: bad path → exit 2 (bad_input),
  undecodable → exit 4 (decode_failed), `--engine madmom` → exit 3 (engine_unavailable).
- End-to-end `bun run src/index.tsx analyze <wav>` → `C (I) → F (IV) → G (V) → C (I)`;
  `doctor` protocol probe → ✓ "librosa speaks contract 1.0.0".
- `uv run --project engine pytest`: **25 pass** (12 schema + 13 librosa). `ruff`: clean.
  `bun test`: **62 pass**.

**Caveat:** synthesized clean-sine triads (the easy case). Real-world accuracy is the §9
gate, still pending the fixture set.

## 2b. librosa accuracy gate (preview + fallback floor) — ☐ pending

## 3. Contract round-trip (types.ts ⇄ schema.json ⇄ mock sidecar) — ✅ PASS (2026-05-23)

The locked contract round-trips both ways against the committed mock sidecar:
- **TS:** `src/core/validate.ts` validates mock output against `src/core/types.ts`
  (strict unknown-key rejection, `null`≠missing, gap-free chord contiguity, confidence
  ∈[0,1], `parseEngineOutput` Analysis|EngineError discriminator). `bun test`: **21 pass**.
- **Python:** mock output validates against `engine/schema.json` +
  `engine/engine-info.schema.json` (incl. unknown-key, range, contractVersion-pattern,
  uniqueItems). `pytest`: **10 pass**. `tsc --noEmit`: clean.
- Note: `engine.ts` (the runtime *consumer* that wraps `validate.ts`) is built in
  Milestone B/Phase 2 — Phase 0 proves the contract + validator, not the spawn wrapper.

## 4. `bun build --compile` with OpenTUI native deps on macOS-arm64 — ☐ pending
The other unverified assumption: whether a single compiled binary embeds and runs
the `@opentui/*` per-platform native deps. If it fails → ship the `bun run` source path.
