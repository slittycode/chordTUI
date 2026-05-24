"""Blocking librosa accuracy gate on the synthetic fixture set (PLAN.md §9).

These are clean additive-sine triads (tests/fixtures/make_fixtures.py) — the *easiest*
possible input. The gate proves the librosa engine runs end-to-end and is broadly correct on
a representative progression set; it does NOT measure real-world accuracy (see
docs/probe-matrix.md). Gate: key >= 0.75, chord (root-aware MajMin WCSR) >= 0.55, aggregated
over all fixtures. Ground truth is derived from the fixture specs (the single source of
truth); the committed WAVs under tests/fixtures/audio/ are what gets analyzed.
"""
import json
import pathlib
import subprocess
import sys

FIXTURES_DIR = pathlib.Path(__file__).resolve().parents[1] / "fixtures"
sys.path.insert(0, str(FIXTURES_DIR))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import make_fixtures as mf  # noqa: E402
from accuracy import chord_score, key_accuracy, key_correct  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[2]
ANALYZE = ROOT / "engine" / "analyze.py"
AUDIO_DIR = FIXTURES_DIR / "audio"

KEY_FLOOR = 0.75
CHORD_FLOOR = 0.55


def _analyze(wav):
    p = subprocess.run(
        [sys.executable, str(ANALYZE), "--engine", "librosa", "--file", str(wav), "--json"],
        capture_output=True,
        text=True,
    )
    assert p.returncode == 0, p.stdout + p.stderr
    return json.loads(p.stdout)


def test_librosa_accuracy_gate(capsys):
    key_results = []
    total_dur = 0.0
    total_correct = 0.0
    rows = []
    for spec in mf.FIXTURES:
        gt = mf.ground_truth(spec)
        wav = AUDIO_DIR / gt["audio"]
        assert wav.exists(), f"missing committed fixture {wav} (run make_fixtures.py)"
        data = _analyze(wav)
        kc = key_correct(data["key"], gt["key"])
        cs = chord_score(data["chords"], gt["segments"], data["durationSec"])
        key_results.append(kc)
        total_dur += data["durationSec"]
        total_correct += cs * data["durationSec"]
        rows.append((spec["name"], kc, cs))

    key_acc = key_accuracy(key_results)
    chord_acc = total_correct / total_dur

    with capsys.disabled():
        print("\nlibrosa accuracy gate (synthetic harmonic triads):")
        for name, kc, cs in rows:
            print(f"  {name:24s} key={'ok' if kc else 'MISS':4s} chord={cs:.3f}")
        print(f"  AGGREGATE  key={key_acc:.3f} (floor {KEY_FLOOR})  "
              f"chord={chord_acc:.3f} (floor {CHORD_FLOOR})")

    assert key_acc >= KEY_FLOOR, f"key accuracy {key_acc:.3f} < {KEY_FLOOR}"
    assert chord_acc >= CHORD_FLOOR, f"chord score {chord_acc:.3f} < {CHORD_FLOOR}"
