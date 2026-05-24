# chordTUI

chordTUI is a macOS terminal tool for finding the **musical key**, the **chords over time**, and
the **chord progression** of an audio file. In plain English: you point it at a song (WAV, FLAC,
or MP3) and it tells you the key and the chords, either as a one-shot command or in an interactive
terminal UI.

Under the hood it's a TypeScript/Bun front end driving a Python audio-analysis engine over a
strict JSON contract, so the two halves are independent and a better engine can drop in later
without changing the UI.

## What it can and can't do (read this first)

With the default **btc** engine, chordTUI reports **extended chords** (major/minor **plus 7ths,
sus, etc.**) over time and a single key, at roughly commercial-grade accuracy. The librosa
fallback (no install needed) is triads-only. It is honest about uncertainty: a feature an engine
can't compute is **removed, not faked**, and silence shows as an explicit no-chord (`N`) span.

- **Accuracy is real, not aspirational.** The btc engine is BTC-ISMIR19, whose published score is
  ~80.8% MIREX chord WCSR; chordTUI reproduces it byte-for-byte (a fidelity gate guarantees we
  inherit it). Measured independently on GuitarSet (real audio): **0.76 chord WCSR, 0.84 key
  accuracy** — and that's *out-of-domain* solo guitar, below its in-domain pop ceiling.
- It still gets weaker on quiet, busy, or atonal passages; **relative major/minor** (C major vs
  A minor) is genuinely hard for any system on a short clip. The promise is "roughly matches a
  human on familiar music," **not 100%**.
- Without the btc install, the librosa fallback is triads-only (it's a rule-based preview).

## Licensing — fully permissive

chordTUI is **MIT**, and so is every engine it ships: librosa (ISC clean core) and the accurate
**btc** tier (BTC-ISMIR19, MIT — code *and* committed weights). There is no NonCommercial tier and
no consent gate; nothing here restricts commercial use. (An earlier opt-in `madmom` tier carried
CC-BY-NC-SA NonCommercial models — it has been retired in favour of btc.)

## Install (from source)

You need [Bun](https://bun.sh/) for the terminal app and [uv](https://docs.astral.sh/uv/) for the
Python engine. From the repository root:

```sh
bun install --frozen-lockfile
bun link                              # installs `chordtui` (+ alias `chord`) on your PATH
chordtui setup                        # installs librosa (clean core) + btc (the accurate engine)
```

`chordtui setup` installs the librosa clean core (`engine/.venv`) and, by default, the **btc**
accuracy engine into a separate `engine/.venv-btc` (a one-time PyTorch download; skip with
`--no-btc`). The command name is `chordtui` (alias `chord`); from source you can also run
`bun run src/index.tsx`.

## Use

```sh
# One-shot analysis (uses btc by default when installed, else the librosa preview):
chordtui analyze path/to/song.wav            # human-readable summary
chordtui analyze path/to/song.wav --json     # the raw Analysis JSON
chordtui analyze path/to/song.wav --engine librosa   # force an engine
chordtui analyze path/to/song.wav --no-cache         # skip the result cache

# Diagnostics / info:
chordtui doctor          # per-engine table: installed / working (ran on a WAV) / license / default
chordtui engine-info     # the engine's capabilities + versions
chordtui setup           # install the clean core + btc (the accurate engine)

# Interactive TUI (no arguments):
chordtui
```

In the **TUI**: pick a file to analyze; it shows the instant librosa preview, then upgrades to
btc if that engine is installed. Keys: `q` quit · `f` pick another file · `esc` back / cancel a
running analysis · `m` toggle fast/accurate mode. Quitting or cancelling always stops the Python
child — it is never left running.

**Caching:** results are cached per audio file + engine under `~/.cache/chordtui/`, so re-running
the same file is instant. `--no-cache` bypasses it; replacing the audio invalidates it
automatically (the key is the file's content hash).

## Engines, accuracy, and licenses

| Engine | Role | License | Accuracy |
|--------|------|---------|----------|
| **librosa** | clean core: instant preview + always-on fallback | ISC | triads only; rule-based |
| **btc** | default accuracy tier (extended chords + chord-derived key) | **MIT** (code *and* weights) | ~80.8% MIREX chord WCSR (published); GuitarSet 0.76 chord / 0.84 key |
| **essentia** | reserved alternative (no engine module yet) | AGPL-3.0 | — |

Be clear-eyed about the trade-off:

- **librosa is reliable and always installs, but weaker.** Rule-based key (Krumhansl–Schmuckler)
  + template-matched chroma chords, triads only. Its floor is measured on *synthetic fixtures*
  (`tests/fixtures/`) — it proves the engine runs, not real-recording accuracy. It's the instant
  preview and the fallback when btc isn't installed.
- **btc is the accurate default — and fully permissive.** It is BTC-ISMIR19, a bi-directional
  transformer (MIT, with committed weights), vendored in-repo at `engine/vendor/btc` and installed
  by `chordtui setup` into a separate `engine/.venv-btc` (PyTorch, Python 3.11 — kept out of the
  clean-core lock). chordTUI reproduces BTC's reference inference **byte-for-byte** (a fidelity
  gate, `tests/py/test_btc_fidelity.py`), so it inherits the published ~80.8% MIREX WCSR rather
  than claiming a number. Independently measured on **GuitarSet** (real, CC-BY audio): **0.76 chord
  WCSR, 0.84 key accuracy** — on *out-of-domain* solo guitar, so below its in-domain pop ceiling.
  Reproduce with `tools/eval_guitarset.py`; details in `docs/probe-matrix.md §7`.

  Once btc is installed it is the default for the final result; the CLI and TUI fall back to the
  librosa preview whenever it isn't.

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
