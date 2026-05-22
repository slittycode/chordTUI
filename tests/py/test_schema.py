"""Python side of the contract round-trip: mock sidecar output must validate against
engine/schema.json, and satisfy the gap-free invariant that JSON Schema cannot express."""
import importlib.util
import json
import math
import pathlib
import subprocess
import sys

import jsonschema
import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]
MOCK = ROOT / "engine" / "mock_sidecar.py"
SCHEMA = json.loads((ROOT / "engine" / "schema.json").read_text())
ENGINE_INFO_SCHEMA = json.loads((ROOT / "engine" / "engine-info.schema.json").read_text())
EPS = 1e-6


def _load_mock_module():
    spec = importlib.util.spec_from_file_location("mock_sidecar", MOCK)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


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


def test_engine_info_validates_against_schema():
    for payload in ("sparse", "full"):
        p = run_mock("engine-info", "--payload", payload)
        assert p.returncode == 0, p.stderr
        jsonschema.validate(json.loads(p.stdout), ENGINE_INFO_SCHEMA)


def test_unknown_top_level_field_is_rejected():
    """Strict parity with validate.ts: additionalProperties:false rejects unknown keys."""
    data = json.loads(run_mock("analyze", "--payload", "sparse").stdout)
    data["tempoBpm"] = 120
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(data, SCHEMA)


def test_confidence_out_of_range_rejected():
    data = json.loads(run_mock("analyze", "--payload", "full").stdout)
    data["key"]["confidence"] = 2  # documented range is [0, 1]
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(data, SCHEMA)


def test_malformed_contract_version_rejected():
    data = json.loads(run_mock("analyze", "--payload", "sparse").stdout)
    data["contractVersion"] = "1.0"  # missing patch — tightened pattern rejects it
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(data, SCHEMA)


def test_duplicate_capabilities_rejected():
    data = json.loads(run_mock("analyze", "--payload", "full").stdout)
    data["engineCapabilities"] = data["engineCapabilities"] + ["key"]
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(data, SCHEMA)


def test_producer_refuses_to_emit_nan():
    """Bare NaN/Infinity are invalid JSON for JS and slip past jsonschema range checks,
    so the emitter must reject them (allow_nan=False) rather than print them."""
    mock = _load_mock_module()
    for bad in (float("nan"), float("inf"), float("-inf")):
        with pytest.raises(ValueError):
            mock._dumps({"confidence": bad})


def test_jsonschema_alone_would_let_nan_pass_range():
    """Documents WHY the producer guard above is necessary: jsonschema's [0,1] bounds
    do not catch NaN, so allow_nan=False is the real defense."""
    data = json.loads(run_mock("analyze", "--payload", "full").stdout)
    data["key"]["confidence"] = math.nan
    jsonschema.validate(data, SCHEMA)  # passes — the gap the producer guard closes
