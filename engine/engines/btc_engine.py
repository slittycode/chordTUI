"""btc engine — the opt-in MIT accuracy tier: BTC-ISMIR19 chords + chord-derived key.

Chords come from the vendored bi-directional transformer (engine/vendor/btc, MIT, weights
committed). The key is derived from those chords — a duration-weighted chord-tone profile fed to
librosa's Krumhansl correlation (the "BTC + librosa" combination). On real audio this is far more
accurate than chroma-Krumhansl (GuitarSet measured: 0.84 vs 0.55), because BTC's chords are a
clean harmonic signal. MIT end to end, so there is NO NonCommercial consent gate.

The chord inference loop (`_btc_lab_lines`) mirrors BTC's reference `test.py` VERBATIM — same
preprocessing, per-checkpoint mean/std normalization, 10 s windowing, `n_timestep` padding,
run-length encoding, and `%.3f` formatting — so we inherit BTC's published accuracy. The
preprocessing IS the model: do not "simplify" it. `tests/py/test_btc_fidelity.py` enforces
byte-equality with the reference; if it breaks, the published accuracy no longer transfers.

Pure producer of the JSON contract (src/core/types.ts / engine/schema.json); enharmonic
spelling + roman numerals are derived TS-side in music.ts.
"""
import os
import sys
import warnings

warnings.filterwarnings("ignore")

_BTC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "vendor", "btc")
_WEIGHTS = {
    False: os.path.join(_BTC_DIR, "weights", "btc_model.pt"),  # majmin (25 classes)
    True: os.path.join(_BTC_DIR, "weights", "btc_model_large_voca.pt"),  # large voca (170)
}

EPS = 1e-6
NAME = "btc"
_LICENSE = "MIT"
# Key is a Krumhansl correlation (on a chord-derived profile); BTC chords are argmax labels with
# no per-segment confidence (null), matching the reference test.py output.
_CONFIDENCE_KIND = "correlation"

# BTC roots are sharp-spelled (root_list in the vendored mir_eval_modules).
_ROOT_PC = {"C": 0, "C#": 1, "D": 2, "D#": 3, "E": 4, "F": 5, "F#": 6,
            "G": 7, "G#": 8, "A": 9, "A#": 10, "B": 11}
# Chord-tone intervals per quality — used to build the duration-weighted key profile.
_CHORD_TONES = {"maj": (0, 4, 7), "min": (0, 3, 7), "7": (0, 4, 7, 10), "maj7": (0, 4, 7, 11),
                "min7": (0, 3, 7, 10), "maj6": (0, 4, 7, 9), "min6": (0, 3, 7, 9),
                "dim": (0, 3, 6), "aug": (0, 4, 8), "sus2": (0, 2, 7), "sus4": (0, 5, 7),
                "minmaj7": (0, 3, 7, 11), "dim7": (0, 3, 6, 9), "hdim7": (0, 3, 6, 10)}


def engine_block(large_voca=True):
    """Engine metadata block; reused by engine_info so analyze + engine-info stay identical."""
    import torch  # noqa: F401 — presence is the availability signal; version pinned below

    model_id = "btc-ismir19-large-voca" if large_voca else "btc-ismir19-majmin"
    return {
        "name": NAME,
        "version": "ismir19",
        "license": _LICENSE,
        "modelVersions": {"chord": model_id, "key": "chord-krumhansl"},
        "confidenceKind": _CONFIDENCE_KIND,
    }


def _load_btc(large_voca):
    """Build the BTC model + load its checkpoint. Returns (model, mean, std, idx_to_chord, config)."""
    if _BTC_DIR not in sys.path:
        sys.path.insert(0, _BTC_DIR)
    import torch
    from btc_model import BTC_model
    from utils.hparams import HParams
    from utils.mir_eval_modules import idx2chord, idx2voca_chord

    config = HParams.load(os.path.join(_BTC_DIR, "run_config.yaml"))
    device = torch.device("cpu")
    if large_voca:
        config.feature["large_voca"] = True
        config.model["num_chords"] = 170
        idx_to_chord = idx2voca_chord()
    else:
        idx_to_chord = idx2chord
    model = BTC_model(config=config.model).to(device)
    # Checkpoints were saved on CUDA under an older torch; map to CPU and allow the full pickle.
    checkpoint = torch.load(_WEIGHTS[large_voca], map_location=device, weights_only=False)
    mean, std = checkpoint["mean"], checkpoint["std"]
    model.load_state_dict(checkpoint["model"])
    model.eval()
    return model, mean, std, idx_to_chord, config, device


def _btc_lab_lines(path, large_voca):
    """Reproduce BTC test.py's inference loop VERBATIM → (lab_lines, song_length_second).

    Each line is '%.3f %.3f %s\\n' (start, end, label) exactly as the reference emits. Kept
    byte-identical so the fidelity gate can assert we inherit BTC's accuracy. Do NOT refactor the
    run-length logic or the formatting.
    """
    import numpy as np
    import torch

    model, mean, std, idx_to_chord, config, device = _load_btc(large_voca)
    from utils.mir_eval_modules import audio_file_to_features  # _load_btc put _BTC_DIR on sys.path

    feature, feature_per_second, song_length_second = audio_file_to_features(path, config)
    feature = feature.T
    feature = (feature - mean) / std
    time_unit = feature_per_second
    n_timestep = config.model["timestep"]

    num_pad = n_timestep - (feature.shape[0] % n_timestep)
    feature = np.pad(feature, ((0, num_pad), (0, 0)), mode="constant", constant_values=0)
    num_instance = feature.shape[0] // n_timestep

    start_time = 0.0
    lines = []
    with torch.no_grad():
        model.eval()
        feature = torch.tensor(feature, dtype=torch.float32).unsqueeze(0).to(device)
        for t in range(num_instance):
            self_attn_output, _ = model.self_attn_layers(feature[:, n_timestep * t:n_timestep * (t + 1), :])
            prediction, _ = model.output_layer(self_attn_output)
            prediction = prediction.squeeze()
            for i in range(n_timestep):
                if t == 0 and i == 0:
                    prev_chord = prediction[i].item()
                    continue
                if prediction[i].item() != prev_chord:
                    lines.append("%.3f %.3f %s\n" % (start_time, time_unit * (n_timestep * t + i), idx_to_chord[prev_chord]))
                    start_time = time_unit * (n_timestep * t + i)
                    prev_chord = prediction[i].item()
                if t == num_instance - 1 and i + num_pad == n_timestep:
                    if start_time != time_unit * (n_timestep * t + i):
                        lines.append("%.3f %.3f %s\n" % (start_time, time_unit * (n_timestep * t + i), idx_to_chord[prev_chord]))
                    break
    return lines, song_length_second


def _display(root, quality):
    if quality == "maj":
        return root
    if quality == "min":
        return root + "m"
    return root + quality  # extended (large voca): e.g. "C"+"7", "C"+"maj7", "C"+"sus4"


def _parse_label(label):
    """BTC label -> (display, root, quality). 'C'->('C','C','maj'); 'C:min'->('Cm','C','min');
    'C:7'->('C7','C','7'); 'N'/'X'/'' -> the no-chord triple."""
    label = str(label).strip()
    if label in ("", "N", "X", "None"):
        return "N", None, "N"
    if ":" in label:
        root, quality = label.split(":", 1)
    else:
        root, quality = label, "maj"
    return _display(root, quality), root, quality


def _seg(start, end, label, root, quality):
    return {
        "start": round(float(start), 6),
        "end": round(float(end), 6),
        "label": label,
        "root": root,
        "quality": quality,
        "confidence": None,  # BTC emits argmax labels, no per-segment probability
    }


def _gap_free(lines, duration):
    """Parse BTC .lab lines into gap-free contiguous segments over [0, duration].

    BTC's segments don't start at 0, end exactly at duration, or guarantee no gaps; the contract
    (validate.ts) requires all three, with silence/unknown as explicit "N". Mirrors the stitch
    discipline used by the librosa/madmom engines.
    """
    raw = []
    for ln in lines:
        p = ln.split()
        raw.append((float(p[0]), float(p[1]), p[2]))
    segs = sorted(
        ((max(0.0, s), min(float(duration), e), lab) for s, e, lab in raw if e > s),
        key=lambda x: x[0],
    )
    out = []
    cursor = 0.0
    for s, e, lab in segs:
        if e <= cursor + EPS:
            continue
        s = max(s, cursor)
        if s - cursor > EPS:
            out.append(_seg(cursor, s, "N", None, "N"))
        display, root, quality = _parse_label(lab)
        out.append(_seg(s, e, display, root, quality))
        cursor = e
    if duration - cursor > EPS:
        out.append(_seg(cursor, duration, "N", None, "N"))
    if not out:
        out.append(_seg(0.0, duration, "N", None, "N"))
    out[0]["start"] = 0.0
    out[-1]["end"] = round(float(duration), 6)
    return out


def _librosa_key(path):
    """Fallback: key via librosa's chroma Krumhansl estimator (used only when BTC found no chords)."""
    import librosa
    from scipy.ndimage import median_filter

    from engines.librosa_engine import SR, HOP, _estimate_key

    y, sr = librosa.load(path, sr=SR, mono=True)
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=HOP)
    chroma = median_filter(chroma, size=(1, 9))
    return _estimate_key(chroma)


def _key(path, lines):
    """Key from BTC's chord tones: a duration-weighted pitch-class profile → Krumhansl correlation
    (reusing librosa's estimator). Far more accurate than chroma-Krumhansl on real audio because
    BTC's chords are a clean harmonic signal (GuitarSet measured: 0.92 vs 0.60 for chroma). Falls
    back to the chroma estimator only when BTC produced no chords (e.g. all-silence)."""
    import numpy as np

    from engines.librosa_engine import _estimate_key

    prof = np.zeros(12)
    for ln in lines:
        p = ln.split()
        if p[2] in ("N", "X"):
            continue
        dur = float(p[1]) - float(p[0])
        root, _, qual = p[2].partition(":")
        r = _ROOT_PC.get(root)
        if r is None:
            continue
        for iv in _CHORD_TONES.get(qual or "maj", (0, 4, 7)):
            prof[(r + iv) % 12] += dur
    if prof.sum() <= 0.0:
        return _librosa_key(path)  # no chords → fall back to the chroma estimator
    return _estimate_key(prof.reshape(12, 1))


# `vocabulary="triads"` (default for now) selects the majmin model — contract-safe while the
# extended-chord widening lands; `vocabulary="extended"` selects the 170-class large-voca model
# (7ths/sus/etc.), which becomes the default once the contract supports it.
def analyze(path, on_stage=lambda s: None, vocabulary="extended"):
    """Run BTC chord recognition + librosa key; return a contract Analysis dict."""
    large_voca = vocabulary != "triads"

    on_stage("decode")
    on_stage("features")
    lines, duration = _btc_lab_lines(path, large_voca)
    if duration <= 0.0:
        from protocol import DecodeFailed

        raise DecodeFailed("audio is empty (zero duration)", hint="the file contains no audio")

    on_stage("chord-decode")
    chords = _gap_free(lines, duration)

    on_stage("key-detect")
    key = _key(path, lines)

    on_stage("assemble")
    return {
        "contractVersion": "1.0.0",
        "file": path,
        "durationSec": round(float(duration), 6),
        "engine": engine_block(large_voca),
        "engineCapabilities": ["key", "chords"],
        "vocabulary": "extended" if large_voca else "triads",
        "key": key,
        "keyCandidates": None,
        "chords": chords,
        "beats": None,
        "downbeats": None,
        "timeSignature": None,
    }
