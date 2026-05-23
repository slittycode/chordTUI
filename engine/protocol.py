"""Shared contract I/O for the real engine harnesses (analyze.py / engine_info.py).

Pure stdlib. Mirrors the IPC contract in src/core/types.ts and engine/schema.json:
  stdout : exactly ONE JSON object — an Analysis / EngineInfoResponse, or {"error": {...}}.
  stderr : NDJSON, one object per line — {"type":"progress",...} / {"type":"log",...}.
  exit   : 0 ok / 2 bad input / 3 engine unavailable / 4 analysis-or-internal failure.

The mock sidecar deliberately stays standalone (it has its own copies); do not import it.
"""
import json
import sys

CONTRACT_VERSION = "1.0.0"

# Coarse, ordered progress stages (mirror ENGINE_STAGES in src/core/types.ts). These are
# pipeline markers, NOT capability claims — an engine emits a stage as it passes through it
# even if the stage produces nothing it exposes (e.g. librosa emits "beat-track" but has no
# beats capability).
STAGES = ["decode", "features", "beat-track", "chord-decode", "key-detect", "assemble"]

# EngineError.kind -> process exit code. Mirrors EXIT / ERROR_KIND_EXIT in src/core/types.ts.
EXIT = {"ok": 0, "bad_input": 2, "engine_unavailable": 3, "analysis_failed": 4}
ERROR_KIND_EXIT = {
    "bad_input": EXIT["bad_input"],
    "engine_unavailable": EXIT["engine_unavailable"],
    "decode_failed": EXIT["analysis_failed"],
    "internal": EXIT["analysis_failed"],
}


class EngineFailure(Exception):
    """A failure mappable to a contract error kind + exit code. Default kind: internal."""

    kind = "internal"

    def __init__(self, detail, hint=None):
        super().__init__(detail)
        self.detail = detail
        self.hint = hint


class BadInput(EngineFailure):
    kind = "bad_input"


class DecodeFailed(EngineFailure):
    kind = "decode_failed"


class EngineUnavailable(EngineFailure):
    kind = "engine_unavailable"


def dumps(obj):
    """Serialize to JSON, refusing NaN/Infinity.

    Python's default json.dumps emits bare NaN/Infinity tokens — invalid JSON for Bun/JS
    (JSON.parse throws) that also slip past jsonschema numeric-range checks. allow_nan=False
    makes a producer fail loudly (ValueError) instead, BEFORE anything reaches stdout.
    """
    return json.dumps(obj, allow_nan=False)


def emit_progress(stage, index, total):
    """Write one NDJSON progress event to stderr."""
    sys.stderr.write(dumps({"type": "progress", "stage": stage, "index": index, "total": total}))
    sys.stderr.write("\n")
    sys.stderr.flush()


def emit_log(level, msg):
    """Write one NDJSON log event to stderr."""
    sys.stderr.write(dumps({"type": "log", "level": level, "msg": msg}))
    sys.stderr.write("\n")
    sys.stderr.flush()


def write_result(obj):
    """Write the single stdout JSON document.

    Serialize first so a NaN failure raises (and is caught upstream) WITHOUT having written a
    partial document — the contract requires exactly one well-formed object on stdout.
    """
    text = dumps(obj)
    sys.stdout.write(text)
    sys.stdout.flush()


def error_envelope(kind, detail, hint=None):
    """Build the {"error": {...}} stdout document for a failed run."""
    err = {"kind": kind, "detail": detail}
    if hint is not None:
        err["hint"] = hint
    return {"error": err}
