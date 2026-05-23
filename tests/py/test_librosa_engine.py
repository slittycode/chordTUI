"""librosa engine ⇄ contract tests.

Fixtures are synthesized at runtime (numpy + scipy.io.wavfile) so the suite needs no
copyrighted audio — the same I–IV–V–I-in-C-major pattern as engine/probe_madmom.py. Under
`uv run --project engine pytest`, sys.executable is the py3.9 venv that has librosa, so the
real engine runs end to end.
"""
import json
import pathlib
import subprocess
import sys

import jsonschema
import numpy as np
import pytest
from scipy.io import wavfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
ENGINE = ROOT / "engine"
ANALYZE = ENGINE / "analyze.py"
ENGINE_INFO = ENGINE / "engine_info.py"
SCHEMA = json.loads((ENGINE / "schema.json").read_text())
ENGINE_INFO_SCHEMA = json.loads((ENGINE / "engine-info.schema.json").read_text())
SR = 44100
EPS = 1e-6


def _tone(freqs, dur):
    t = np.linspace(0, dur, int(SR * dur), endpoint=False)
    sig = sum(np.sin(2 * np.pi * f * t) for f in freqs)
    env = np.ones_like(sig)
    n = int(0.01 * SR)
    env[:n] = np.linspace(0, 1, n)
    env[-n:] = np.linspace(1, 0, n)
    return sig * env


@pytest.fixture(scope="module")
def cmajor_wav(tmp_path_factory):
    """A I–IV–V–I progression in C major (C, F, G triads), 1.6 s per chord."""
    chords = {
        "C": [261.63, 329.63, 392.00],  # C E G
        "F": [349.23, 440.00, 523.25],  # F A C
        "G": [392.00, 493.88, 587.33],  # G B D
    }
    audio = np.concatenate([_tone(chords[c], 1.6) for c in ("C", "F", "G", "C")])
    audio = audio / np.max(np.abs(audio)) * 0.9
    path = tmp_path_factory.mktemp("audio") / "cmajor.wav"
    wavfile.write(str(path), SR, (audio * 32767).astype(np.int16))
    return path


def _run(script, *args):
    return subprocess.run(
        [sys.executable, str(script), *args], capture_output=True, text=True
    )


def _reject_constant(token):
    raise AssertionError(f"engine emitted a non-finite JSON constant: {token!r}")


def _analyze(wav, *extra):
    p = _run(ANALYZE, "--engine", "librosa", "--file", str(wav), "--json", *extra)
    return p


def test_analyze_validates_against_schema(cmajor_wav):
    p = _analyze(cmajor_wav)
    assert p.returncode == 0, p.stdout + p.stderr
    jsonschema.validate(json.loads(p.stdout), SCHEMA)


def test_chords_gap_free_and_cover_duration(cmajor_wav):
    data = json.loads(_analyze(cmajor_wav).stdout)
    chords = data["chords"]
    assert chords[0]["start"] == 0
    for a, b in zip(chords, chords[1:]):
        assert abs(a["end"] - b["start"]) < EPS, (a, b)
        assert b["end"] > b["start"]
    assert abs(chords[-1]["end"] - data["durationSec"]) < EPS


def test_key_is_c_major(cmajor_wav):
    key = json.loads(_analyze(cmajor_wav).stdout)["key"]
    assert key["tonic"] == "C"
    assert key["mode"] == "major"
    assert 0.0 <= key["confidence"] <= 1.0


def test_chords_recover_the_c_f_g_progression(cmajor_wav):
    """Triads are C/F/G major. Empirically the despeckled engine recovers ~100% coverage on
    this clean synth; assert ≥ 0.85 to leave slack for librosa-version / platform drift."""
    data = json.loads(_analyze(cmajor_wav).stdout)
    duration = data["durationSec"]
    in_key = {("C", "maj"), ("F", "maj"), ("G", "maj")}
    covered = sum(
        c["end"] - c["start"] for c in data["chords"] if (c["root"], c["quality"]) in in_key
    )
    labels = {(c["root"], c["quality"]) for c in data["chords"]}
    assert ("C", "maj") in labels
    assert covered / duration >= 0.85, data["chords"]


def test_no_nan_or_infinity_in_output(cmajor_wav):
    # allow_nan=False on the producer means non-finite constants can never reach stdout.
    json.loads(_analyze(cmajor_wav).stdout, parse_constant=_reject_constant)


def test_quality_vocabulary_is_triads_only(cmajor_wav):
    for c in json.loads(_analyze(cmajor_wav).stdout)["chords"]:
        assert c["quality"] in {"maj", "min", "N"}
        if c["quality"] == "N":
            assert c["root"] is None and c["label"] == "N"
        else:
            assert c["root"] is not None


def test_bad_path_is_bad_input(tmp_path):
    p = _analyze(tmp_path / "does-not-exist.wav")
    assert p.returncode == 2, p.stdout
    assert json.loads(p.stdout)["error"]["kind"] == "bad_input"


def test_undecodable_file_is_decode_failed(tmp_path):
    junk = tmp_path / "junk.wav"
    junk.write_text("this is not audio")
    p = _analyze(junk)
    assert p.returncode == 4, p.stdout
    assert json.loads(p.stdout)["error"]["kind"] == "decode_failed"


def test_empty_audio_is_decode_failed(tmp_path):
    # A zero-sample WAV decodes fine but has nothing to analyze; emitting a [0,0] segment
    # would violate end > start. The engine must reject it, not produce malformed output.
    empty = tmp_path / "empty.wav"
    wavfile.write(str(empty), SR, np.array([], dtype=np.int16))
    p = _analyze(empty)
    assert p.returncode == 4, p.stdout
    assert json.loads(p.stdout)["error"]["kind"] == "decode_failed"


def test_unimplemented_engine_is_unavailable(cmajor_wav):
    p = _run(ANALYZE, "--engine", "madmom", "--file", str(cmajor_wav), "--json")
    assert p.returncode == 3, p.stdout
    assert json.loads(p.stdout)["error"]["kind"] == "engine_unavailable"


def test_progress_stages_are_emitted_in_order(cmajor_wav):
    stderr = _analyze(cmajor_wav).stderr
    stages = [
        json.loads(line)["stage"]
        for line in stderr.splitlines()
        if line.strip() and json.loads(line).get("type") == "progress"
    ]
    assert stages == ["decode", "features", "beat-track", "chord-decode", "key-detect", "assemble"]


def test_engine_info_validates_against_schema():
    p = _run(ENGINE_INFO, "--engine", "librosa")
    assert p.returncode == 0, p.stdout + p.stderr
    info = json.loads(p.stdout)
    jsonschema.validate(info, ENGINE_INFO_SCHEMA)
    assert info["name"] == "librosa"
    assert info["capabilities"] == ["key", "chords"]


def test_engine_info_unavailable_for_madmom():
    # Assert exit code + kind only — the error envelope is NOT an EngineInfoResponse, so it
    # must not be validated against engine-info.schema.json.
    p = _run(ENGINE_INFO, "--engine", "madmom")
    assert p.returncode == 3, p.stdout
    assert json.loads(p.stdout)["error"]["kind"] == "engine_unavailable"
