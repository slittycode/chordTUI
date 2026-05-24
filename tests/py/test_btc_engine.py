"""btc engine ⇄ contract tests — SKIPPED unless torch is installed (the opt-in btc tier).

These exercise the full analyze.py --engine btc path (extended vocabulary) and assert it conforms
to the contract. Run with the btc venv:  engine/.venv-btc/bin/python -m pytest tests/py/test_btc_engine.py
(`uv run --project engine pytest` uses the clean-core py3.9 venv → no torch → skip). The fidelity
of the chords themselves (vs BTC's reference) is proven separately in test_btc_fidelity.py.
"""
import json
import pathlib
import subprocess
import sys

import jsonschema
import pytest

pytest.importorskip("torch")

ROOT = pathlib.Path(__file__).resolve().parents[2]
ANALYZE = ROOT / "engine" / "analyze.py"
ENGINE_INFO = ROOT / "engine" / "engine_info.py"
SCHEMA = json.loads((ROOT / "engine" / "schema.json").read_text())
ENGINE_INFO_SCHEMA = json.loads((ROOT / "engine" / "engine-info.schema.json").read_text())
AUDIO = ROOT / "tests" / "fixtures" / "audio" / "btc_fidelity.wav"  # 24s C-G-Am-F in C major
EPS = 1e-6


def _analyze():
    p = subprocess.run(
        [sys.executable, str(ANALYZE), "--engine", "btc", "--file", str(AUDIO), "--json"],
        capture_output=True,
        text=True,
    )
    assert p.returncode == 0, p.stdout + p.stderr
    return json.loads(p.stdout)


def test_btc_validates_and_is_extended_mit():
    d = _analyze()
    jsonschema.validate(d, SCHEMA)
    assert d["engine"]["name"] == "btc"
    assert d["engine"]["license"] == "MIT"  # no NonCommercial strings
    assert d["vocabulary"] == "extended"


def test_btc_chords_gap_free_and_cover_duration():
    d = _analyze()
    chords = d["chords"]
    assert chords[0]["start"] == 0
    for a, b in zip(chords, chords[1:]):
        assert abs(a["end"] - b["start"]) < EPS, (a, b)
        assert b["end"] > b["start"]
    assert abs(chords[-1]["end"] - d["durationSec"]) < EPS


def test_btc_key_is_c_major():
    key = _analyze()["key"]  # librosa Krumhansl on the C-major fixture
    assert key["tonic"] == "C"
    assert key["mode"] == "major"
    assert 0.0 <= key["confidence"] <= 1.0


def test_btc_engine_info_advertises_extended_models():
    p = subprocess.run(
        [sys.executable, str(ENGINE_INFO), "--engine", "btc"], capture_output=True, text=True
    )
    assert p.returncode == 0, p.stdout + p.stderr
    info = json.loads(p.stdout)
    jsonschema.validate(info, ENGINE_INFO_SCHEMA)
    assert info["name"] == "btc"
    assert info["modelVersions"]["chord"] == "btc-ismir19-large-voca"
