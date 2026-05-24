"""madmom engine ⇄ contract tests — SKIPPED unless madmom is installed.

madmom is an opt-in, CC-BY-NC-SA, install-fragile tier (PLAN.md §1/§10); it is not in the
clean-core lock, so these skip in CI and on a default `uv sync`. They run only after
`chord setup` (or the manual recipe in docs/probe-matrix.md) installs madmom into the venv —
i.e. the manual/nightly gate. When present, the same schema + gap-free + correctness
invariants the librosa engine satisfies must hold for madmom.
"""
import json
import pathlib
import subprocess
import sys

import jsonschema
import pytest

pytest.importorskip("madmom")

ROOT = pathlib.Path(__file__).resolve().parents[2]
ANALYZE = ROOT / "engine" / "analyze.py"
ENGINE_INFO = ROOT / "engine" / "engine_info.py"
SCHEMA = json.loads((ROOT / "engine" / "schema.json").read_text())
ENGINE_INFO_SCHEMA = json.loads((ROOT / "engine" / "engine-info.schema.json").read_text())
AUDIO_DIR = ROOT / "tests" / "fixtures" / "audio"
EPS = 1e-6


def _analyze(name):
    wav = AUDIO_DIR / f"{name}.wav"
    p = subprocess.run(
        [sys.executable, str(ANALYZE), "--engine", "madmom", "--file", str(wav), "--json"],
        capture_output=True,
        text=True,
    )
    assert p.returncode == 0, p.stdout + p.stderr
    return json.loads(p.stdout)


def test_madmom_output_validates_against_schema():
    data = _analyze("i_iv_v_i_c_major")
    jsonschema.validate(data, SCHEMA)
    assert data["engine"]["name"] == "madmom"
    assert data["engine"]["confidenceKind"] == "posterior"


def test_madmom_chords_gap_free_and_cover_duration():
    data = _analyze("i_iv_v_i_c_major")
    chords = data["chords"]
    assert chords[0]["start"] == 0
    for a, b in zip(chords, chords[1:]):
        assert abs(a["end"] - b["start"]) < EPS, (a, b)
        assert b["end"] > b["start"]
    assert abs(chords[-1]["end"] - data["durationSec"]) < EPS


def test_madmom_key_is_c_major():
    key = _analyze("i_iv_v_i_c_major")["key"]
    assert key["tonic"] == "C"
    assert key["mode"] == "major"


def test_madmom_engine_info_advertises_capabilities():
    p = subprocess.run(
        [sys.executable, str(ENGINE_INFO), "--engine", "madmom"],
        capture_output=True,
        text=True,
    )
    assert p.returncode == 0, p.stdout + p.stderr
    info = json.loads(p.stdout)
    jsonschema.validate(info, ENGINE_INFO_SCHEMA)
    assert info["name"] == "madmom"
    assert "chords" in info["capabilities"] and "key" in info["capabilities"]
