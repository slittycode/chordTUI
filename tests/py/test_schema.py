"""Python side of the contract round-trip: mock sidecar output must validate against
engine/schema.json, and satisfy the gap-free invariant that JSON Schema cannot express."""
import json
import pathlib
import subprocess
import sys

import jsonschema

ROOT = pathlib.Path(__file__).resolve().parents[2]
MOCK = ROOT / "engine" / "mock_sidecar.py"
SCHEMA = json.loads((ROOT / "engine" / "schema.json").read_text())
EPS = 1e-6


def run_mock(*args):
    p = subprocess.run(
        [sys.executable, str(MOCK), *args],
        capture_output=True,
        text=True,
    )
    return p


def test_sparse_validates_against_schema():
    p = run_mock("analyze", "--payload", "sparse")
    assert p.returncode == 0, p.stderr
    jsonschema.validate(json.loads(p.stdout), SCHEMA)


def test_full_validates_against_schema():
    p = run_mock("analyze", "--payload", "full")
    assert p.returncode == 0, p.stderr
    jsonschema.validate(json.loads(p.stdout), SCHEMA)


def test_chords_gap_free_and_cover_duration():
    data = json.loads(run_mock("analyze", "--payload", "full").stdout)
    chords = data["chords"]
    assert chords[0]["start"] == 0
    for a, b in zip(chords, chords[1:]):
        assert abs(a["end"] - b["start"]) < EPS, (a, b)
        assert b["end"] > b["start"]
    assert abs(chords[-1]["end"] - data["durationSec"]) < EPS


def test_no_chord_segments_have_null_root():
    data = json.loads(run_mock("analyze", "--payload", "full").stdout)
    for seg in data["chords"]:
        if seg["label"] == "N":
            assert seg["root"] is None and seg["quality"] == "N"
        else:
            assert seg["root"] is not None


def test_error_scenario_is_nonzero_with_envelope():
    p = run_mock("analyze", "--scenario", "error")
    assert p.returncode != 0
    assert json.loads(p.stdout)["error"]["kind"] == "decode_failed"
