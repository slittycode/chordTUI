"""Pure accuracy metrics for the engine fixture gate (PLAN.md §9). No librosa import.

- key_correct: tonic compared by pitch class (so C# == Db) AND mode match.
- chord_score: duration-weighted, root-aware MajMin WCSR (the MIREX MajMin family) — the
  fraction of [0, duration] where the predicted (root pitch class, maj/min/N class) equals
  the ground-truth one. Roots are compared by pitch class, so an engine's "G#" matches a
  ground-truth "Ab".
"""

_PC = {
    "C": 0, "C#": 1, "Db": 1, "D": 2, "D#": 3, "Eb": 3, "E": 4, "F": 5,
    "F#": 6, "Gb": 6, "G": 7, "G#": 8, "Ab": 8, "A": 9, "A#": 10, "Bb": 10, "B": 11,
}


def note_pc(name):
    """Pitch class 0-11 for a note name, or None for None/unparseable."""
    return _PC.get(name) if name else None


def majmin(quality):
    """Collapse a quality to the MajMin vocabulary: maj / min / N (everything else)."""
    return quality if quality in ("maj", "min") else "N"


def _chord_class(seg):
    """(root_pc, majmin) for a segment; no-chord -> (None, 'N')."""
    q = majmin(seg["quality"])
    return (None, "N") if q == "N" else (note_pc(seg["root"]), q)


def _overlap(a0, a1, b0, b1):
    return max(0.0, min(a1, b1) - max(a0, b0))


def chord_score(pred, truth, duration):
    """Duration-weighted, root-aware MajMin score over [0, duration], in [0, 1]."""
    if duration <= 0:
        return 0.0
    correct = 0.0
    for p in pred:
        cls = _chord_class(p)
        for t in truth:
            if _chord_class(t) == cls:
                correct += _overlap(p["start"], p["end"], t["start"], t["end"])
    return correct / duration


def key_correct(pred_key, truth_key):
    """True iff tonic (by pitch class) and mode both match."""
    return (
        note_pc(pred_key["tonic"]) == note_pc(truth_key["tonic"])
        and pred_key["mode"] == truth_key["mode"]
    )


def key_accuracy(results):
    """Fraction of True values in a list of per-fixture key_correct results."""
    return sum(1 for r in results if r) / len(results) if results else 0.0
