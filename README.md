# chordTUI

chordTUI is a terminal app for checking the musical key, chords, and chord progression of an audio file. In plain English: you point it at a song file such as a WAV, MP3, or FLAC, and it tries to tell you the key and the chords over time.

The app is still in an early stage. The TypeScript/Bun terminal interface talks to a Python audio-analysis engine through a strict JSON contract.

## Install for Development

You need [Bun](https://bun.sh/) for the terminal app and [uv](https://docs.astral.sh/uv/) for the Python engine.

From the repository root:

```sh
bun install --frozen-lockfile
uv sync --project engine --locked
```

The project currently runs from source. The planned `chord setup` command is not implemented yet, so it does not install engines for you.

## Run

The command name is `chord`. While working from source, use `bun run src/index.tsx` before the same commands:

```sh
bun run src/index.tsx --help
bun run src/index.tsx doctor
bun run src/index.tsx analyze path/to/song.wav --engine librosa
bun run src/index.tsx analyze path/to/song.wav --engine librosa --json
```

When installed as a command later, those become:

```sh
chord --help
chord doctor
chord analyze path/to/song.wav
```

Running with no command launches the interactive terminal interface:

```sh
bun run src/index.tsx
```

## Engines and Licensing

`librosa` is the default clean engine. It is installed through the Python project and is the current working engine for analysis.

`madmom` and `essentia` are optional future accuracy engines. They are not installed by default and are not implemented as working engine modules yet. They also carry important licensing caveats:

- `madmom`: code is permissive, but the useful pretrained models are CC-BY-NC-SA, which means non-commercial use.
- `essentia`: AGPL-3.0, which has stronger sharing obligations.

Because of those licenses, the default install stays on the clean `librosa` engine.

## Validate

Run the same checks used by CI:

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
uv sync --project engine --locked
uv run --project engine pytest
uv run --project engine ruff check engine/
```
