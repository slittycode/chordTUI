#!/usr/bin/env python3
"""Synthesize the CC0 accuracy fixtures (audio + ground truth).

Pure additive-sine triads (numpy) — the same approach as engine/probe_madmom.py and
tests/py/test_librosa_engine.py. There is no soundfont and no recording, so the audio is
CC0 by construction (PLAN.md §9 named fluidsynth+soundfont, but fluidsynth is not installed
and a soundfont would add a fragile, licensed dependency; clean sines also keep the floor
gate honest — see docs/probe-matrix.md).

These are the *easiest* possible inputs: sustained triads, no timbre/transients/noise. They
prove the engine runs end-to-end on a representative progression set; they do NOT measure
real-world accuracy.

Run from the repo root to (re)generate the committed fixtures:
    uv run --project engine python tests/fixtures/make_fixtures.py

Importable too: `FIXTURES`, `render(spec, out_dir)`, `ground_truth(spec)`.
"""
import json
import pathlib
import re

import numpy as np
from scipy.io import wavfile

SR = 22050  # librosa.load resamples to this anyway; synthesizing here keeps files small
CHORD_SEC = 1.6  # long enough for stable CQT chroma; matches the existing librosa test
SILENCE_SEC = 1.0
ROOT_MIDI = 48  # octave-3 root; thirds/fifths stack above. C3 = 48.

# Sharp-only pitch-class names (the librosa engine emits roots from this table); ground truth
# may use flats (e.g. "Ab") — the accuracy metric compares roots by pitch class, not string.
_PC = {
    "C": 0, "C#": 1, "Db": 1, "D": 2, "D#": 3, "Eb": 3, "E": 4, "F": 5,
    "F#": 6, "Gb": 6, "G": 7, "G#": 8, "Ab": 8, "A": 9, "A#": 10, "Bb": 10, "B": 11,
}

HERE = pathlib.Path(__file__).resolve().parent
AUDIO_DIR = HERE / "audio"
GROUND_TRUTH_DIR = HERE / "ground_truth"


def _midi_to_hz(midi):
    return 440.0 * 2.0 ** ((midi - 69) / 12.0)


def _parse_chord(symbol):
    """'C'->(root='C',quality='maj'); 'Am'->('A','min'); 'Ab'->('Ab','maj'); 'N'->(None,'N')."""
    if symbol == "N":
        return None, "N"
    m = re.fullmatch(r"([A-G][#b]?)(m?)", symbol)
    if not m:
        raise ValueError(f"unparseable chord symbol: {symbol!r}")
    root, minor = m.group(1), m.group(2)
    return root, ("min" if minor else "maj")


def _triad_freqs(root, quality):
    base = ROOT_MIDI + _PC[root]
    third = base + (3 if quality == "min" else 4)
    fifth = base + 7
    return [_midi_to_hz(base), _midi_to_hz(third), _midi_to_hz(fifth)]


def _tone(freqs, dur):
    t = np.linspace(0, dur, int(SR * dur), endpoint=False)
    sig = sum(np.sin(2 * np.pi * f * t) for f in freqs)
    env = np.ones_like(sig)
    n = max(1, int(0.01 * SR))  # 10 ms attack/release to avoid clicks
    env[:n] = np.linspace(0, 1, n)
    env[-n:] = np.linspace(1, 0, n)
    return sig * env


def _silence(dur):
    return np.zeros(int(SR * dur))


# Each fixture: a list of (symbol, seconds). "N" = silence. The label spells flats where the
# key conventionally does (e.g. "Ab"); the metric normalizes roots to pitch class.
FIXTURES = [
    {
        "name": "i_iv_v_i_c_major",
        "key": {"tonic": "C", "mode": "major"},
        "progression": [("C", CHORD_SEC), ("F", CHORD_SEC), ("G", CHORD_SEC), ("C", CHORD_SEC)],
        "expectedRomanNumerals": ["I", "IV", "V", "I"],
    },
    {
        # vi-IV-I-V (the "axis"). vi and V get extra tonic-flanking length so the
        # Krumhansl key estimator locks C major rather than the relative A minor.
        "name": "vi_iv_i_v_c_major",
        "key": {"tonic": "C", "mode": "major"},
        "progression": [("A", 0)],  # placeholder, replaced below
        "expectedRomanNumerals": ["vi", "IV", "I", "V"],
    },
    {
        # i-iv-V-i in A minor. The E-major (harmonic-minor) dominant carries G#, the
        # leading tone that disambiguates A minor from its relative C major.
        "name": "i_iv_v_i_a_minor",
        "key": {"tonic": "A", "mode": "minor"},
        "progression": [("Am", CHORD_SEC), ("Dm", CHORD_SEC), ("E", CHORD_SEC), ("Am", CHORD_SEC)],
        "expectedRomanNumerals": ["i", "iv", "V", "i"],
    },
    {
        # Chords interleaved with silence -> explicit no-chord ("N") segments.
        "name": "silence_sections",
        "key": {"tonic": "C", "mode": "major"},
        "progression": [
            ("C", CHORD_SEC), ("N", SILENCE_SEC), ("F", CHORD_SEC),
            ("N", SILENCE_SEC), ("G", CHORD_SEC), ("C", CHORD_SEC),
        ],
        "expectedRomanNumerals": ["I", None, "IV", None, "V", "I"],
    },
    {
        # bVI (Ab) bookended by clear-key chords so the key stays C major while the
        # out-of-key chord gets NO roman numeral (romanNumeral returns null).
        "name": "out_of_key_chord",
        "key": {"tonic": "C", "mode": "major"},
        "progression": [
            ("C", CHORD_SEC), ("F", CHORD_SEC), ("Ab", CHORD_SEC), ("G", CHORD_SEC),
            ("C", CHORD_SEC), ("F", CHORD_SEC), ("C", CHORD_SEC),
        ],
        "expectedRomanNumerals": ["I", "IV", None, "V", "I", "IV", "I"],
    },
]

# vi-IV-I-V with tonic emphasis (longer I and a resolving I tail kept implicit by lengthening V).
FIXTURES[1]["progression"] = [
    ("A", CHORD_SEC), ("F", CHORD_SEC), ("C", CHORD_SEC * 2), ("G", CHORD_SEC), ("C", CHORD_SEC),
]
FIXTURES[1]["expectedRomanNumerals"] = ["vi", "IV", "I", "V", "I"]


def ground_truth(spec):
    """Derive the expected key + gap-free segments from a fixture spec."""
    segments = []
    t = 0.0
    for symbol, dur in spec["progression"]:
        root, quality = _parse_chord(symbol)
        label = "N" if quality == "N" else (root if quality == "maj" else f"{root}m")
        segments.append({
            "start": round(t, 6),
            "end": round(t + dur, 6),
            "root": root,
            "quality": quality,
            "label": label,
        })
        t += dur
    return {
        "audio": f"{spec['name']}.wav",
        "durationSec": round(t, 6),
        "key": spec["key"],
        "segments": segments,
        "expectedRomanNumerals": spec["expectedRomanNumerals"],
    }


def render(spec, out_dir):
    """Write <name>.wav into out_dir; return its path."""
    out_dir = pathlib.Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    parts = []
    for symbol, dur in spec["progression"]:
        root, quality = _parse_chord(symbol)
        parts.append(_silence(dur) if quality == "N" else _tone(_triad_freqs(root, quality), dur))
    audio = np.concatenate(parts)
    peak = np.max(np.abs(audio))
    if peak > 0:
        audio = audio / peak * 0.9
    path = out_dir / f"{spec['name']}.wav"
    wavfile.write(str(path), SR, (audio * 32767).astype(np.int16))
    return path


def main():
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    GROUND_TRUTH_DIR.mkdir(parents=True, exist_ok=True)
    for spec in FIXTURES:
        wav = render(spec, AUDIO_DIR)
        gt = ground_truth(spec)
        (GROUND_TRUTH_DIR / f"{spec['name']}.json").write_text(json.dumps(gt, indent=2) + "\n")
        print(f"wrote {wav.name} ({gt['durationSec']}s) + ground_truth/{spec['name']}.json")


if __name__ == "__main__":
    main()
