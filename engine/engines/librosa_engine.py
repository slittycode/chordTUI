"""librosa engine — the clean-core (ISC), always-installs tier.

Rule-based key (Krumhansl-Schmuckler template correlation) + template-matched triad chords
over CQT chroma. Capabilities: ["key", "chords"]. confidenceKind: "correlation" (template
scores, NOT probabilities). Triads only (maj/min/N) per the MVP vocabulary.

Pure producer of the JSON contract (src/core/types.ts / engine/schema.json); all spelling /
roman-numeral work happens TS-side in music.ts.
"""
import warnings

# librosa/numba emit assorted runtime warnings; keep them off the NDJSON stderr stream.
warnings.filterwarnings("ignore")

import numpy as np  # noqa: E402
from scipy.ndimage import median_filter  # noqa: E402

import librosa  # noqa: E402

from protocol import DecodeFailed  # noqa: E402

SR = 22050  # downsample target; well above the harmonic range we analyze, fast chroma
HOP = 512  # one hop length shared by chroma, RMS, and frame→time so the frame grids align
PITCH_CLASSES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# Krumhansl-Kessler key profiles (major, minor), indexed from the tonic.
_KS_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
_KS_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])

# Binary triad templates: a major triad on root r lights {r, r+4, r+7}; minor {r, r+3, r+7}.
_TRIAD_INTERVALS = {"maj": (0, 4, 7), "min": (0, 3, 7)}

# No-chord ("N") is gated on raw-signal RMS, not chroma: chroma_cqt normalizes every frame to
# unit max, so a silent frame's chroma looks like a full chord (CQT ringing from neighbouring
# chords + that normalization). RMS of the source audio is genuinely ~0 in silence, so it is the
# honest silence signal. A frame whose RMS is below this (audio peak-normalized to 0.9) is N.
_SILENCE_RMS = 1e-2

# Chord runs shorter than this many frames are boundary flicker (e.g. a 1-frame transient
# at a chord change) and get absorbed into the preceding run. ~5 frames ≈ 0.1 s at the
# default hop, below the granularity at which a triad label is meaningful.
_MIN_RUN_FRAMES = 5


def _load(path):
    """Decode any librosa-readable file (WAV/FLAC/MP3 via soundfile/audioread) to mono."""
    try:
        y, sr = librosa.load(path, sr=SR, mono=True)
    except Exception as e:  # corrupt / non-audio / unreadable -> contract decode_failed
        raise DecodeFailed(
            f"could not decode audio: {type(e).__name__}: {e}".rstrip(": "),
            hint="is this a valid audio file?",
        )
    return y, sr


def _build_templates():
    """24 unit-normalized binary triad templates -> (templates[24,12], labels[24])."""
    rows = []
    labels = []
    for quality in ("maj", "min"):
        for root in range(12):
            vec = np.zeros(12)
            for interval in _TRIAD_INTERVALS[quality]:
                vec[(root + interval) % 12] = 1.0
            rows.append(vec / np.linalg.norm(vec))
            labels.append((root, quality))
    return np.array(rows), labels


_TEMPLATES, _TEMPLATE_LABELS = _build_templates()


def _estimate_key(chroma):
    """Krumhansl-Schmuckler: correlate the mean chroma against 24 rotated profiles."""
    mean = chroma.mean(axis=1)
    best = None  # (r, tonic, mode)
    for mode, profile in (("major", _KS_MAJOR), ("minor", _KS_MINOR)):
        for tonic in range(12):
            rotated = np.roll(profile, tonic)
            r = np.corrcoef(mean, rotated)[0, 1]
            if not np.isfinite(r):
                r = 0.0
            if best is None or r > best[0]:
                best = (r, tonic, mode)
    r, tonic, mode = best
    return {
        "tonic": PITCH_CLASSES[tonic],
        "mode": mode,
        "confidence": round(float(min(1.0, max(0.0, r))), 6),
    }


def _frame_labels(chroma):
    """Per-frame (label_index, score): index 0..23 -> a triad, -1 -> N (no-chord).

    Cosine similarity of two non-negative vectors is in [0, 1] by construction, so the
    per-frame score is a valid confidence with no clamping needed. A numerically-zero chroma
    frame (norm ~0) can't be cosine-compared (0/0); it is left as N. Real silence is detected
    upstream from the audio RMS — see analyze().
    """
    norms = np.linalg.norm(chroma, axis=0)
    n = chroma.shape[1]
    idx = np.full(n, -1, dtype=int)
    score = np.zeros(n)
    for f in range(n):
        if norms[f] < 1e-9:
            continue  # numerically silent chroma -> leave as N (avoid 0/0)
        sims = (_TEMPLATES @ chroma[:, f]) / norms[f]  # templates already unit-norm
        best = int(np.argmax(sims))
        idx[f] = best
        score[f] = sims[best]
    return idx, score


def _despeckle(idx, min_run):
    """Absorb sub-threshold runs (boundary flicker) into the preceding run, left to right."""
    idx = idx.copy()
    n = len(idx)
    runs = []
    i = 0
    while i < n:
        j = i
        while j + 1 < n and idx[j + 1] == idx[i]:
            j += 1
        runs.append((i, j + 1))
        i = j + 1
    for a, b in runs:
        if b - a < min_run:
            idx[a:b] = idx[a - 1] if a > 0 else (idx[b] if b < n else idx[a])
    return idx


def _segments(idx, score, times, duration):
    """Run-length-encode per-frame labels into gap-free contiguous chord segments."""
    n = len(idx)
    segments = []
    i = 0
    while i < n:
        j = i
        while j + 1 < n and idx[j + 1] == idx[i]:
            j += 1
        start = 0.0 if not segments else segments[-1]["end"]
        end = duration if j + 1 >= n else float(times[j + 1])
        label_idx = int(idx[i])

        if label_idx < 0:
            seg = {"label": "N", "root": None, "quality": "N", "confidence": None}
        else:
            root, quality = _TEMPLATE_LABELS[label_idx]
            name = PITCH_CLASSES[root]
            window = score[i : j + 1]
            voiced = window[window > 0]
            conf = round(float(voiced.mean()), 6) if voiced.size else None
            seg = {
                "label": name if quality == "maj" else name + "m",
                "root": name,
                "quality": quality,
                "confidence": conf,
            }
        seg["start"] = round(start, 6)
        seg["end"] = round(end, 6)
        segments.append(seg)
        i = j + 1

    # Force exact coverage of [0, duration] (RLE boundaries + rounding can drift a hair).
    if segments:
        segments[0]["start"] = 0.0
        segments[-1]["end"] = round(float(duration), 6)
    return segments


def analyze(path, on_stage=lambda s: None):
    """Run the librosa key+chord analysis and return a contract Analysis dict."""
    on_stage("decode")
    y, sr = _load(path)
    duration = round(float(librosa.get_duration(y=y, sr=sr)), 6)
    # An empty / zero-duration file decodes fine but has nothing to analyze: key detection
    # would be fabricated and the lone chord segment would be [0, 0] (invalid: end must be
    # > start). Surface it as a contract error rather than emit garbage.
    if y.size == 0 or duration <= 0.0:
        raise DecodeFailed("audio is empty (zero duration)", hint="the file contains no audio")

    on_stage("features")
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=HOP)
    # Temporal median filter denoises chroma frame-to-frame (de-flickers the chord track)
    # without the artifacts of median-filtering categorical labels directly.
    chroma = median_filter(chroma, size=(1, 9))
    times = librosa.frames_to_time(np.arange(chroma.shape[1]), sr=sr, hop_length=HOP)
    # Per-frame loudness on the SAME frame grid, used to mark genuine silence as N.
    rms = librosa.feature.rms(y=y, hop_length=HOP)[0]

    on_stage("beat-track")  # coarse pipeline marker; librosa exposes no beats

    on_stage("chord-decode")
    idx, score = _frame_labels(chroma)
    # Override to N where the source audio is silent (rms ~0). Aligned defensively by length:
    # rms/chroma frame counts can differ by one depending on centering.
    m = min(idx.size, rms.size)
    silent = rms[:m] < _SILENCE_RMS
    idx[:m][silent] = -1
    score[:m][silent] = 0.0
    idx = _despeckle(idx, _MIN_RUN_FRAMES)
    chords = _segments(idx, score, times, duration)

    on_stage("key-detect")
    key = _estimate_key(chroma)

    on_stage("assemble")
    return {
        "contractVersion": "1.0.0",
        "file": path,
        "durationSec": duration,
        "engine": {
            "name": "librosa",
            "version": librosa.__version__,
            "license": "ISC",
            "modelVersions": {},
            "confidenceKind": "correlation",
        },
        "engineCapabilities": ["key", "chords"],
        "vocabulary": "triads",
        "key": key,
        "keyCandidates": None,
        "chords": chords,
        "beats": None,
        "downbeats": None,
        "timeSignature": None,
    }
