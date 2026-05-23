#!/usr/bin/env python3
"""Real analysis sidecar — the producer side of the JSON contract (src/core/types.ts).

Usage:
  analyze.py --engine librosa|madmom|essentia --file PATH [--json]

  stdout : exactly ONE JSON object — an Analysis, or {"error": {...}}.
  stderr : NDJSON progress events, one per pipeline stage.
  exit   : 0 ok / 2 bad input / 3 engine unavailable / 4 analysis-or-internal failure.

Only librosa is implemented at this milestone; madmom/essentia parse as valid choices but
return engine_unavailable (exit 3) until their own milestones add an engine module.
"""
import argparse
import os
import sys
import warnings

warnings.filterwarnings("ignore")

from protocol import (  # noqa: E402
    ERROR_KIND_EXIT,
    EXIT,
    STAGES,
    BadInput,
    EngineFailure,
    EngineUnavailable,
    emit_progress,
    error_envelope,
    write_result,
)

# Engines with a working analysis module. Availability is registry-gated, not import-gated:
# madmom may import in a dev venv, but without engines/madmom_engine.py it is not usable.
IMPLEMENTED = {"librosa"}


class _ContractArgumentParser(argparse.ArgumentParser):
    """argparse's default emits usage to stderr + exits 2 with EMPTY stdout, which makes the
    TS consumer raise EngineSpawnError("no stdout"). Override so every usage error becomes a
    contract-correct bad_input envelope on stdout."""

    def error(self, message):
        write_result(error_envelope("bad_input", message, hint="see analyze.py --help"))
        sys.exit(EXIT["bad_input"])


def _parse_args(argv):
    p = _ContractArgumentParser(prog="analyze.py")
    p.add_argument("--engine", default="librosa", choices=["librosa", "madmom", "essentia"])
    p.add_argument("--file", required=True)
    p.add_argument("--vocabulary", default="triads")  # accepted; triads-only at MVP
    p.add_argument("--json", action="store_true")  # stdout is always JSON; flag is a no-op
    return p.parse_args(argv)


def run(argv):
    args = _parse_args(argv)
    try:
        if args.engine not in IMPLEMENTED:
            raise EngineUnavailable(
                f"engine '{args.engine}' is not available yet",
                hint="run `chord setup` or use --engine librosa",
            )
        if not os.path.isfile(args.file):
            raise BadInput(f"file not found: {args.file}", hint="check the path")

        from engines import librosa_engine

        def on_stage(stage):
            emit_progress(stage, STAGES.index(stage), len(STAGES))

        write_result(librosa_engine.analyze(args.file, on_stage))
        return EXIT["ok"]
    except EngineFailure as e:
        write_result(error_envelope(e.kind, e.detail, e.hint))
        return ERROR_KIND_EXIT[e.kind]
    except Exception as e:  # noqa: BLE001 — any unexpected fault maps to a contract error
        write_result(error_envelope("internal", f"{type(e).__name__}: {e}"))
        return EXIT["analysis_failed"]


if __name__ == "__main__":
    sys.exit(run(sys.argv[1:]))
