#!/usr/bin/env python3
"""Measure the btc engine's accuracy on GuitarSet (CC-BY real audio) — the reproducibility script
behind chordTUI's headline accuracy numbers.

WHAT IT MEASURES
  - chord majmin WCSR (the standard MIREX metric, via mir_eval) using BTC's majmin model
  - key accuracy: chord-derived key (btc_engine._key) vs GuitarSet's key_mode
  duration-weighted across the 180 "_comp" (chordal) excerpts.

DATASET (GuitarSet, CC-BY 4.0 — https://zenodo.org/records/3371780)
  Download + unzip:
    annotation.zip          -> <gset>/annotation/*.jams        (39 MB)
    audio_mono-mic.zip       -> <gset>/audio/*_mic.wav          (657 MB)

RUN (needs torch — use the btc venv created by `chordtui setup`):
    engine/.venv-btc/bin/python tools/eval_guitarset.py <gset>/audio <gset>/annotation

RESULT ON RECORD (2026-05-24, commit 6965b68, macOS-arm64, torch 2.12 / librosa 0.11):
    chord majmin WCSR : 0.760   key accuracy : 0.844   (over 180 _comp excerpts)
  NOTE: GuitarSet is solo acoustic guitar — OUT OF DOMAIN for BTC (trained on pop full-mixes), so
  this is below BTC's in-domain pop ceiling (~80.8% MIREX). The fidelity gate
  (tests/py/test_btc_fidelity.py) proves we reproduce BTC byte-for-byte, so a number here below the
  published one is domain shift, not an integration bug.
"""
import glob
import json
import os
import sys

import numpy as np
import mir_eval

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "engine"))
from engines import btc_engine  # noqa: E402

_PC = {"C": 0, "C#": 1, "DB": 1, "D": 2, "D#": 3, "EB": 3, "E": 4, "F": 5, "F#": 6, "GB": 6,
       "G": 7, "G#": 8, "AB": 8, "A": 9, "A#": 10, "BB": 10, "B": 11}


def _pc(name):
    return _PC.get(name.strip().upper())


def _ref_chords(jp):
    ann = next(a for a in json.load(open(jp))["annotations"] if a["namespace"] == "chord")
    ints = np.array([[d["time"], d["time"] + d["duration"]] for d in ann["data"]])
    return ints, [d["value"] for d in ann["data"]]


def _ref_key(jp):
    km = next((a for a in json.load(open(jp))["annotations"]
               if a["namespace"] == "key_mode" and a["data"]), None)
    if not km:
        return None
    v = km["data"][0]["value"].replace(":", " ").split()
    return (_pc(v[0]), v[1].lower() if len(v) > 1 else "major")


def main(audio_dir, ann_dir, limit=None):
    comps = sorted(glob.glob(os.path.join(ann_dir, "*_comp.jams")))
    if limit:
        comps = comps[: int(limit)]
    tot_dur = wcsr_sum = 0.0
    key_results = []
    n = 0
    for jp in comps:
        wav = os.path.join(audio_dir, os.path.basename(jp)[:-5] + "_mic.wav")
        if not os.path.exists(wav):
            continue
        ri, rl = _ref_chords(jp)
        majmin_lines, _ = btc_engine._btc_lab_lines(wav, large_voca=False)
        ei = np.array([[float(x.split()[0]), float(x.split()[1])] for x in majmin_lines])
        el = [x.split()[2] for x in majmin_lines]
        dur = float(ri[:, 1].max() - ri[:, 0].min())
        wcsr_sum += mir_eval.chord.evaluate(ri, rl, ei, el)["majmin"] * dur
        tot_dur += dur
        ext_lines, _ = btc_engine._btc_lab_lines(wav, large_voca=True)
        key = btc_engine._key(wav, ext_lines)
        gt = _ref_key(jp)
        if gt is not None:
            key_results.append(_pc(key["tonic"]) == gt[0] and key["mode"] == gt[1])
        n += 1
        if n % 20 == 0:
            print(f"  ...{n} files, running majmin={wcsr_sum / tot_dur:.3f}", flush=True)
    print("\nGuitarSet (solo acoustic guitar — OUT OF DOMAIN for BTC):")
    print(f"  files evaluated   : {n}")
    print(f"  chord majmin WCSR : {wcsr_sum / tot_dur:.3f}  (duration-weighted)")
    if key_results:
        print(f"  key accuracy      : {sum(key_results) / len(key_results):.3f}  (chord-derived)")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)
