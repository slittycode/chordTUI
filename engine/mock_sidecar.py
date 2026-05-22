#!/usr/bin/env python3
"""Mock analysis sidecar — pure stdlib, no deps.

Speaks the exact contract (engine/schema.json / src/core/types.ts) so the frontend and
engine.ts can be built and tested before the real librosa/madmom engines exist.

Protocol:
  stdout : exactly ONE JSON object — an Analysis, or {"error": {...}}.
  stderr : NDJSON, one object per line — {"type":"progress","stage":...} / {"type":"log",...}.
  exit   : 0 ok / 2 bad input / 3 engine unavailable / 4 analysis-or-internal failure.

Usage:
  mock_sidecar.py analyze     [--payload sparse|full] [--scenario S] [--file F] [--engine E] [--json]
  mock_sidecar.py engine-info [--payload sparse|full]
"""
import argparse
import json
import signal
import sys
import time

STAGES = ["decode", "features", "beat-track", "chord-decode", "key-detect", "assemble"]

# A I-IV-V-I in C major, 1.6s per chord -> gap-free over [0, 6.4].
_SEQ = [("C", "C", "maj"), ("F", "F", "maj"), ("G", "G", "maj"), ("C", "C", "maj")]
_SEG = 1.6
DURATION = round(_SEG * len(_SEQ), 6)


def emit(obj):
    """Write one NDJSON event to stderr."""
    sys.stderr.write(json.dumps(obj) + "\n")
    sys.stderr.flush()


def progress(stages, delay=0.0):
    for i, stage in enumerate(stages):
        emit({"type": "progress", "stage": stage, "index": i, "total": len(stages)})
        if delay:
            time.sleep(delay)


def chords(with_confidence):
    out = []
    t = 0.0
    for label, root, quality in _SEQ:
        seg = {
            "start": round(t, 6),
            "end": round(t + _SEG, 6),
            "label": label,
            "root": root,
            "quality": quality,
            "confidence": 0.9 if with_confidence else None,
        }
        out.append(seg)
        t += _SEG
    return out


def engine_info(payload):
    if payload == "full":
        return {
            "name": "madmom",
            "version": "0.16.1",
            "license": "CC-BY-NC-SA-4.0",
            "modelVersions": {"chord": "deepchroma-crf-v1", "key": "cnnkey-v1"},
            "confidenceKind": "posterior",
        }
    return {
        "name": "librosa",
        "version": "0.10.0",
        "license": "ISC",
        "modelVersions": {},
        "confidenceKind": "correlation",
    }


def analysis(payload):
    full = payload == "full"
    return {
        "contractVersion": "1.0.0",
        "file": "mock://progression.wav",
        "durationSec": DURATION,
        "engine": engine_info(payload),
        "engineCapabilities": (
            ["key", "keyCandidates", "chords", "beats", "downbeats", "timeSignature"]
            if full
            else ["key", "chords"]
        ),
        "vocabulary": "triads",
        "key": {"tonic": "C", "mode": "major", "confidence": 0.92 if full else 0.71},
        "keyCandidates": (
            [
                {"tonic": "C", "mode": "major", "confidence": 0.92},
                {"tonic": "A", "mode": "minor", "confidence": 0.61},
                {"tonic": "G", "mode": "major", "confidence": 0.44},
            ]
            if full
            else None
        ),
        "chords": chords(with_confidence=full),
        "beats": [round(0.4 * i, 6) for i in range(int(DURATION / 0.4) + 1)] if full else None,
        "downbeats": [round(1.6 * i, 6) for i in range(len(_SEQ) + 1)] if full else None,
        "timeSignature": "4/4" if full else None,
    }


def out(obj):
    sys.stdout.write(json.dumps(obj))
    sys.stdout.flush()


def run_analyze(args):
    scenario = args.scenario

    if scenario == "garbage":
        progress(STAGES[:2])
        sys.stdout.write("this is not json <<<")
        sys.stdout.flush()
        return 0

    if scenario == "error":
        progress(STAGES[:1])
        out({"error": {"kind": "decode_failed", "detail": "mock decode failure", "hint": "is this an audio file?"}})
        return 4

    if scenario == "hang":
        # Ignore SIGTERM so the caller must escalate to SIGKILL (tests the grace ladder).
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        progress(STAGES[:2])
        while True:
            time.sleep(3600)

    if scenario == "partial-killed":
        # Respect SIGTERM; emits some progress then blocks until cancelled.
        progress(STAGES[:3])
        while True:
            time.sleep(3600)

    delay = 0.05 if scenario == "slow" else 0.0
    progress(STAGES, delay=delay)
    out(analysis(args.payload))
    return 0


def main():
    p = argparse.ArgumentParser(prog="mock_sidecar")
    p.add_argument("command", nargs="?", default="analyze", choices=["analyze", "engine-info"])
    p.add_argument("--payload", default="sparse", choices=["sparse", "full"])
    p.add_argument(
        "--scenario",
        default="success",
        choices=["success", "slow", "hang", "garbage", "error", "partial-killed"],
    )
    p.add_argument("--file")
    p.add_argument("--engine")
    p.add_argument("--vocabulary", default="triads")
    p.add_argument("--json", action="store_true")
    args = p.parse_args()

    if args.command == "engine-info":
        info = engine_info(args.payload)
        info["contractVersion"] = "1.0.0"
        info["capabilities"] = (
            ["key", "keyCandidates", "chords", "beats", "downbeats", "timeSignature"]
            if args.payload == "full"
            else ["key", "chords"]
        )
        out(info)
        return 0

    return run_analyze(args)


if __name__ == "__main__":
    sys.exit(main())
