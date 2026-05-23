"""madmom engine — the opt-in accuracy tier (code BSD, pretrained models CC-BY-NC-SA 4.0).

Deep-chroma → CRF chord recognition (MajMin triads) + CNN key recognition. confidenceKind:
"posterior" (the CNN key output is a true probability; the chord recognizer exposes no
per-segment confidence, so those are null). Capabilities: ["key", "keyCandidates", "chords"].

NOT installed by default and NOT in the clean-core lock — `chord setup` (or the recipe in
docs/probe-matrix.md) installs it. This module imports madmom lazily inside analyze() so the
package merely existing on disk costs nothing; availability is gated in analyze.py.

Pure producer of the JSON contract (src/core/types.ts / engine/schema.json); enharmonic
spelling + roman numerals are derived TS-side in music.ts.
"""
import warnings

warnings.filterwarnings("ignore")

EPS = 1e-6
_LICENSE = "CC-BY-NC-SA-4.0"  # the pretrained models, which produce the accuracy, are NC


def _parse_chord_label(label):
    """madmom MIREX label -> (display, root, quality). 'C:maj'->('C','C','maj');
    'A:min'->('Am','A','min'); 'N'/'X'/'' -> the no-chord triple."""
    label = str(label).strip()
    if label in ("", "N", "X", "None"):
        return "N", None, "N"
    if ":" in label:
        root, qual = label.split(":", 1)
        quality = "min" if qual.startswith("min") else "maj"
    else:
        root, quality = label, "maj"
    display = root if quality == "maj" else root + "m"
    return display, root, quality


def _parse_key_label(label):
    """madmom key label -> (tonic, mode). 'c major'->('C','major'); 'db minor'->('Db','minor')."""
    name, mode = str(label).strip().lower().split()
    tonic = name[0].upper() + name[1:]
    return tonic, mode


def _seg(start, end, label, root, quality, confidence=None):
    return {
        "start": round(float(start), 6),
        "end": round(float(end), 6),
        "label": label,
        "root": root,
        "quality": quality,
        "confidence": confidence,
    }


def _gap_free(raw, duration):
    """Turn madmom's (start, end, label) list into gap-free segments over [0, duration].

    madmom does not guarantee its segments start at 0, end exactly at duration, or have no
    intra-gaps; the contract (validate.ts) requires all three, with silence as explicit "N".
    """
    segs = sorted(
        (
            (max(0.0, float(s)), min(float(duration), float(e)), lab)
            for s, e, lab in raw
            if float(e) > float(s)
        ),
        key=lambda x: x[0],
    )
    out = []
    cursor = 0.0
    for s, e, lab in segs:
        if e <= cursor + EPS:
            continue  # behind / overlapping the cursor — drop
        s = max(s, cursor)
        if s - cursor > EPS:
            out.append(_seg(cursor, s, "N", None, "N"))
        display, root, quality = _parse_chord_label(lab)
        out.append(_seg(s, e, display, root, quality))
        cursor = e
    if duration - cursor > EPS:
        out.append(_seg(cursor, duration, "N", None, "N"))
    if not out:
        out.append(_seg(0.0, duration, "N", None, "N"))
    out[0]["start"] = 0.0
    out[-1]["end"] = round(float(duration), 6)
    return out


def _duration(path):
    try:
        import soundfile as sf

        info = sf.info(path)
        return round(info.frames / float(info.samplerate), 6)
    except Exception:  # noqa: BLE001 — mp3/other: fall back to librosa's decoder probe
        import librosa

        return round(float(librosa.get_duration(path=path)), 6)


def _key(path):
    """Run the CNN key recognizer; return (KeyResult, top-3 KeyCandidates)."""
    import numpy as np
    from madmom.features.key import CNNKeyRecognitionProcessor, key_prediction_to_label

    probs = np.asarray(CNNKeyRecognitionProcessor()(path)).ravel()
    # Label each of the 24 classes by feeding a one-hot through madmom's own mapping, so the
    # candidate ordering uses madmom's exact class→label convention rather than a guess.
    eye = np.eye(len(probs))
    labels = [key_prediction_to_label(eye[i][np.newaxis, :]) for i in range(len(probs))]
    order = list(np.argsort(probs)[::-1])
    candidates = []
    for i in order[:3]:
        tonic, mode = _parse_key_label(labels[i])
        candidates.append({"tonic": tonic, "mode": mode, "confidence": round(float(probs[i]), 6)})
    return candidates[0], candidates


def _chords(path):
    from madmom.audio.chroma import DeepChromaProcessor
    from madmom.features.chords import DeepChromaChordRecognitionProcessor

    chroma = DeepChromaProcessor()(path)
    return DeepChromaChordRecognitionProcessor()(chroma)


def analyze(path, on_stage=lambda s: None):
    """Run madmom key + chord recognition and return a contract Analysis dict."""
    import madmom

    on_stage("decode")
    duration = _duration(path)
    if duration <= 0.0:
        from protocol import DecodeFailed

        raise DecodeFailed("audio is empty (zero duration)", hint="the file contains no audio")

    on_stage("features")
    raw = _chords(path)

    on_stage("beat-track")  # coarse marker; this tier does not expose beats

    on_stage("chord-decode")
    chords = _gap_free(raw, duration)

    on_stage("key-detect")
    key, candidates = _key(path)

    on_stage("assemble")
    return {
        "contractVersion": "1.0.0",
        "file": path,
        "durationSec": duration,
        "engine": {
            "name": "madmom",
            "version": madmom.__version__,
            "license": _LICENSE,
            "modelVersions": {"chord": "deepchroma-crf", "key": "cnnkey"},
            "confidenceKind": "posterior",
        },
        "engineCapabilities": ["key", "keyCandidates", "chords"],
        "vocabulary": "triads",
        "key": key,
        "keyCandidates": candidates,
        "chords": chords,
        "beats": None,
        "downbeats": None,
        "timeSignature": None,
    }
