"""BTC fidelity gate — the load-bearing accuracy proof.

If our `btc_engine` reproduces BTC's reference `test.py` chord output BYTE-FOR-BYTE on the same
audio, then we inherit BTC's published MIREX accuracy (~80.8% WCSR) — the number isn't *cited*,
it's *inherited*. This test guards that our vendored inference loop + preprocessing never drift
from the reference. The goldens in tests/fixtures/btc_golden/ were generated from the UNMODIFIED
vendored BTC reference (see engine/vendor/btc/PROVENANCE.md), not from our engine.

Skipped unless torch is installed (the opt-in btc tier). Run it with the btc venv:
    engine/.venv-btc/bin/python -m pytest tests/py/test_btc_fidelity.py
(`uv run --project engine pytest` uses the clean-core py3.9 venv, which has no torch → skip.)
"""
import pathlib
import sys

import pytest

pytest.importorskip("torch")

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "engine"))

from engines import btc_engine  # noqa: E402

FIXTURE = ROOT / "tests" / "fixtures" / "audio" / "btc_fidelity.wav"
GOLDEN = ROOT / "tests" / "fixtures" / "btc_golden"


def _ours(large_voca):
    lines, _ = btc_engine._btc_lab_lines(str(FIXTURE), large_voca=large_voca)
    return "".join(lines)


def test_btc_majmin_fidelity_byte_equal():
    assert _ours(False) == (GOLDEN / "btc_fidelity.majmin.lab").read_text()


def test_btc_largevoca_fidelity_byte_equal():
    assert _ours(True) == (GOLDEN / "btc_fidelity.voca.lab").read_text()
