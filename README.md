# chordTUI

chordTUI is a macOS terminal tool for finding the **musical key**, the **chords over time**, and
the **chord progression** of an audio file. In plain English: you point it at a song (WAV, FLAC,
or MP3) and it tells you the key and the chords, either as a one-shot command or in an interactive
terminal UI.

Under the hood it's a TypeScript/Bun front end driving a Python audio-analysis engine over a
strict JSON contract, so the two halves are independent and a better engine can drop in later
without changing the UI.

## What it can and can't do (read this first)

chordTUI reports **triads only** (major/minor) plus a single key. It is honest about uncertainty:
a feature an engine can't compute is **removed, not faked**, and silence shows as an explicit
no-chord (`N`) span.

- It does a good job on clear, familiar pop/rock material with a strong tonal center.
- It gets weaker on quiet, busy, or ambiguous passages, and **degrades on jazz, classical, and
  modal music**. Relative major/minor keys (e.g. C major vs A minor) are genuinely hard.
- The promise is "roughly matches a human on familiar songs," **not 100%**. Sevenths and extended
  chords are deliberately out of scope at this version.

## Personal / non-commercial use

This project assumes **personal, non-commercial** use. That assumption is what makes the optional
`madmom` accuracy engine usable at all (its models are NonCommercial — see Licenses below). The
chordTUI code itself is MIT; the default install stays license-clean (librosa only).

## Install (from source)

You need [Bun](https://bun.sh/) for the terminal app and [uv](https://docs.astral.sh/uv/) for the
Python engine. From the repository root:

```sh
bun install --frozen-lockfile
uv sync --project engine --locked     # creates engine/.venv with the clean core (librosa)
```

The command name is `chord`. While running from source, prefix it with `bun run src/index.tsx`.

## Use

```sh
# One-shot analysis (uses a real engine by default):
bun run src/index.tsx analyze path/to/song.wav            # human-readable summary
bun run src/index.tsx analyze path/to/song.wav --json     # the raw Analysis JSON
bun run src/index.tsx analyze path/to/song.wav --engine librosa   # force an engine
bun run src/index.tsx analyze path/to/song.wav --no-cache         # skip the result cache

# Diagnostics / info:
bun run src/index.tsx doctor          # engine / python / ffmpeg / librosa / madmom status
bun run src/index.tsx engine-info     # the engine's capabilities + versions
bun run src/index.tsx setup           # report engine state; record madmom consent

# Interactive TUI (no arguments):
bun run src/index.tsx
```

In the **TUI**: pick a file to analyze; it shows the instant librosa preview, then upgrades to
madmom if that engine is installed and consented. Keys: `q` quit · `f` pick another file ·
`esc` back / cancel a running analysis · `m` toggle fast/accurate mode. Quitting or cancelling
always stops the Python child — it is never left running.

**Caching:** results are cached per audio file + engine under `~/.cache/chordtui/`, so re-running
the same file is instant. `--no-cache` bypasses it; replacing the audio invalidates it
automatically (the key is the file's content hash).

## Engines, accuracy, and licenses

| Engine | Role | License | Accuracy target |
|--------|------|---------|-----------------|
| **librosa** | clean core: instant preview + always-on fallback | ISC | key ≥ 75%, chord ≥ 55% (floor) |
| **madmom** | opt-in accuracy tier (default once installed + consented) | code BSD, **models CC-BY-NC-SA 4.0 (NonCommercial)** | key ≥ 85%, chord ≥ 70% |
| **essentia** | reserved opt-in alternative (no engine module yet) | AGPL-3.0 | — |

Be clear-eyed about the trade-off:

- **librosa is reliable and always installs, but weaker.** It uses rule-based key detection
  (Krumhansl–Schmuckler) and template-matched chroma chords. Its accuracy floor is measured on
  *clean synthetic sine fixtures* (`tests/fixtures/`) — that proves the engine runs and is broadly
  correct on a representative progression set; it is **not** a measurement of real-recording
  accuracy.
- **madmom is more accurate but NonCommercial and install-fragile.** It uses deep-chroma chord
  recognition + a CNN key model — markedly better on real recordings — but its pretrained models
  are CC-BY-NC-SA, and the 2018 package is fragile to install (pinned Python 3.9 / numpy<1.24).
  It is **not** installed by default and is **not** in the lockfile. Install it explicitly:

  ```sh
  bun run src/index.tsx setup --accept-noncommercial   # record the NonCommercial consent
  # then, the validated macOS-arm64 recipe (also in docs/probe-matrix.md):
  uv venv --python 3.9 engine/.venv
  uv pip install --python engine/.venv "cython<3" "numpy<1.24" "scipy<1.13" \
       "setuptools<60" wheel pip librosa soundfile
  uv pip install --python engine/.venv --no-build-isolation "madmom==0.16.1"
  ```

  Once madmom is installed **and** consented, it becomes the default for the final result; the CLI
  and TUI fall back to librosa whenever it isn't.

Your enharmonic spelling and Roman numerals are derived in TypeScript from `(key, root,
quality)`; out-of-key chords get no Roman numeral (omitted, never invented).

## Validate

The same checks CI runs:

```sh
bun run typecheck
bun test
uv sync --project engine --locked
uv run --project engine pytest                       # includes the blocking librosa accuracy gate
uv run --project engine ruff check engine tests/py
```

The madmom accuracy gate (`tests/py/test_accuracy_madmom.py`) is skipped unless madmom is
installed; it's the manual/nightly check, not a CI blocker.
