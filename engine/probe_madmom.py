"""Phase-0 install probe: prove madmom loads its models and runs on real audio.

Synthesizes a I-IV-V-I progression in C major, then runs madmom's deep-chroma
chord recognizer and CNN key recognizer. Success = both produce output without
ImportError / missing-model / np.float failures.
"""
import sys
import tempfile
import warnings

warnings.filterwarnings("ignore")

import numpy as np  # noqa: E402
from scipy.io import wavfile  # noqa: E402

SR = 44100


def tone(freqs, dur, sr=SR):
    t = np.linspace(0, dur, int(sr * dur), endpoint=False)
    sig = sum(np.sin(2 * np.pi * f * t) for f in freqs)
    # short attack/release envelope to avoid clicks
    env = np.ones_like(sig)
    n = int(0.01 * sr)
    env[:n] = np.linspace(0, 1, n)
    env[-n:] = np.linspace(1, 0, n)
    return sig * env


def make_progression(path):
    chords = {
        "C": [261.63, 329.63, 392.00],   # C E G  (I)
        "F": [349.23, 440.00, 523.25],   # F A C  (IV)
        "G": [392.00, 493.88, 587.33],   # G B D  (V)
    }
    seq = ["C", "F", "G", "C"]
    audio = np.concatenate([tone(chords[c], 1.6) for c in seq])
    audio = audio / np.max(np.abs(audio)) * 0.9
    wavfile.write(path, SR, (audio * 32767).astype(np.int16))
    return seq


def main():
    results = {"build": "ok"}
    wav = tempfile.mktemp(suffix=".wav")
    seq = make_progression(wav)
    print(f"synth: {' -> '.join(seq)} in C major @ {wav}")

    # --- chords (deep chroma -> CRF) ---
    try:
        from madmom.audio.chroma import DeepChromaProcessor
        from madmom.features.chords import DeepChromaChordRecognitionProcessor

        chroma = DeepChromaProcessor()(wav)
        chords = DeepChromaChordRecognitionProcessor()(chroma)
        labels = [str(c[2]) for c in chords]
        print(f"\nCHORDS ok ({len(chords)} segments):")
        for start, end, label in chords:
            print(f"  {float(start):5.1f}-{float(end):5.1f}s  {label}")
        results["chords"] = "ok"
        results["chord_labels"] = labels
    except Exception as e:
        results["chords"] = f"FAIL: {type(e).__name__}: {e}"
        print(f"\nCHORDS FAIL: {type(e).__name__}: {e}")

    # --- key (CNN) ---
    try:
        from madmom.features.key import CNNKeyRecognitionProcessor, key_prediction_to_label

        key = CNNKeyRecognitionProcessor()(wav)
        label = key_prediction_to_label(key)
        print(f"\nKEY ok: {label}")
        results["key"] = "ok"
        results["key_label"] = label
    except Exception as e:
        results["key"] = f"FAIL: {type(e).__name__}: {e}"
        print(f"\nKEY FAIL: {type(e).__name__}: {e}")

    ok = results.get("chords") == "ok" and results.get("key") == "ok"
    print("\n=== PROBE RESULT:", "PASS" if ok else "FAIL", "===")
    print("versions:", "numpy", np.__version__, "py", sys.version.split()[0])
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
