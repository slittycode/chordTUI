#!/usr/bin/env python3
"""Per-engine self-test — proves an engine can RUN, not merely import (for `chord doctor`).

Usage:
  selftest.py --engine librosa|madmom|essentia

Synthesizes a tiny I-IV-V-I C-major WAV (numpy/scipy are clean-core, so this works before any
engine loads), imports the engine's module and runs its real analyze() on that WAV, then prints
exactly ONE JSON line and exits 0 (doctor parses stdout, not the exit code):

  {"engine","installed","working","detail"}

  installed=false  — no engine module (essentia) or the engine's package isn't importable.
  working=false    — the module is installed but analyze() raised (detail = the error).
  working=true     — analyze() succeeded (detail = a short summary, e.g. "detected key C major").

Reuses analyze.py's ENGINE_MODULES registry + importlib dispatch, so a future engine added there
is picked up here automatically.
"""
import argparse
import importlib
import importlib.util
import json
import sys
import tempfile
import warnings

warnings.filterwarnings("ignore")

from analyze import ENGINE_MODULES  # noqa: E402 — share the one engine registry

SR = 44100


def _tone(freqs, dur):
    import numpy as np

    t = np.linspace(0, dur, int(SR * dur), endpoint=False)
    sig = sum(np.sin(2 * np.pi * f * t) for f in freqs)
    env = np.ones_like(sig)
    n = int(0.01 * SR)
    env[:n] = np.linspace(0, 1, n)
    env[-n:] = np.linspace(1, 0, n)
    return sig * env


def _synth(path):
    """Write a I-IV-V-I C-major progression (C, F, G triads), 1.6 s per chord."""
    import numpy as np
    from scipy.io import wavfile

    chords = {
        "C": [261.63, 329.63, 392.00],  # C E G
        "F": [349.23, 440.00, 523.25],  # F A C
        "G": [392.00, 493.88, 587.33],  # G B D
    }
    audio = np.concatenate([_tone(chords[c], 1.6) for c in ("C", "F", "G", "C")])
    audio = audio / np.max(np.abs(audio)) * 0.9
    wavfile.write(path, SR, (audio * 32767).astype(np.int16))


def _selftest(engine):
    module_name = ENGINE_MODULES.get(engine)
    if module_name is None:
        return {"engine": engine, "installed": False, "working": False,
                "detail": "no engine module (deferred)"}
    # The engine module exists on disk; its third-party package (e.g. madmom) must be importable
    # too. madmom_engine imports madmom lazily, so checking the module alone would lie — probe the
    # package spec. The package name equals the engine name for librosa/madmom.
    if importlib.util.find_spec(engine) is None:
        return {"engine": engine, "installed": False, "working": False,
                "detail": f"{engine} package not installed"}

    wav = tempfile.mktemp(suffix=".wav")
    try:
        _synth(wav)
        mod = importlib.import_module(module_name)
        result = mod.analyze(wav, lambda _stage: None)
        key = result.get("key") or {}
        detail = f"detected key {key.get('tonic', '?')} {key.get('mode', '?')}"
        return {"engine": engine, "installed": True, "working": True, "detail": detail}
    except Exception as e:  # noqa: BLE001 — any failure means "installed but not working"
        return {"engine": engine, "installed": True, "working": False,
                "detail": f"{type(e).__name__}: {e}"}


def main(argv):
    p = argparse.ArgumentParser(prog="selftest.py")
    p.add_argument("--engine", default="librosa", choices=["librosa", "madmom", "essentia"])
    args = p.parse_args(argv)
    sys.stdout.write(json.dumps(_selftest(args.engine)) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
