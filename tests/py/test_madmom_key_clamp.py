"""Regression: madmom key confidence is clamped to [0, 1] — runs WITHOUT real madmom.

The clamp bug is otherwise test-invisible: it only fires when a CNN posterior edges past 1.0 by
a float32 epsilon, which a fixture WAV may never produce — so a green madmom suite would not
prove the clamp does anything, and it could be deleted unnoticed. This test forces that exact
input by stubbing madmom in sys.modules, so it lives OUTSIDE test_madmom_engine.py (whose
module-level importorskip would skip it) and runs under the normal CI `uv run pytest`.
"""
import json
import pathlib
import sys
import types

import jsonschema
import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[2]
ENGINE = ROOT / "engine"
KEY_RESULT_SCHEMA = json.loads((ENGINE / "schema.json").read_text())["$defs"]["keyResult"]


def _install_fake_madmom(monkeypatch, probs):
    """Put a minimal fake madmom.features.key into sys.modules (auto-restored by monkeypatch)."""
    madmom = types.ModuleType("madmom")
    madmom.__version__ = "0.16.1-fake"
    features = types.ModuleType("madmom.features")
    key_mod = types.ModuleType("madmom.features.key")

    class CNNKeyRecognitionProcessor:
        def __call__(self, _path):
            return np.asarray(probs)

    def key_prediction_to_label(_prediction):
        return "c major"  # valid 2-token label for every one-hot the engine probes

    key_mod.CNNKeyRecognitionProcessor = CNNKeyRecognitionProcessor
    key_mod.key_prediction_to_label = key_prediction_to_label
    monkeypatch.setitem(sys.modules, "madmom", madmom)
    monkeypatch.setitem(sys.modules, "madmom.features", features)
    monkeypatch.setitem(sys.modules, "madmom.features.key", key_mod)


def test_key_confidence_is_clamped_to_unit_interval(monkeypatch):
    # A 24-class posterior whose max edges past 1.0 — the case that slips past allow_nan=False
    # but violates the contract's confidence ∈ [0, 1] rule (validate.ts / schema.json keyResult).
    probs = np.full(24, 0.01, dtype=np.float32)
    probs[5] = np.float32(1.0) + np.float32(1e-6)
    assert float(probs[5]) > 1.0  # precondition: the bug only fires for a posterior > 1.0

    _install_fake_madmom(monkeypatch, probs)
    if str(ENGINE) not in sys.path:
        sys.path.insert(0, str(ENGINE))
    from engines.madmom_engine import _key

    top, candidates = _key("dummy.wav")

    for cand in candidates:
        assert cand["confidence"] <= 1.0, cand
        jsonschema.validate(cand, KEY_RESULT_SCHEMA)  # the exact unit-interval rule
    jsonschema.validate(top, KEY_RESULT_SCHEMA)
    assert top["confidence"] == 1.0  # the > 1.0 posterior was clamped, not passed through
