#!/usr/bin/env python3
"""Cheap capability probe — the engine-info side of the JSON contract.

Decodes no audio. Prints an EngineInfoResponse (engine/engine-info.schema.json) so the
frontend can build cache keys and discover capabilities without a full analysis.

Usage:
  engine_info.py --engine librosa|madmom|essentia [--json]

  exit 0 + EngineInfoResponse on stdout for an implemented engine; exit 3 + an
  engine_unavailable envelope for one that is not yet implemented.
"""
import argparse
import sys
import warnings

warnings.filterwarnings("ignore")

from protocol import (  # noqa: E402
    CONTRACT_VERSION,
    ERROR_KIND_EXIT,
    EXIT,
    EngineFailure,
    EngineUnavailable,
    error_envelope,
    write_result,
)

IMPLEMENTED = {"librosa"}


class _ContractArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        write_result(error_envelope("bad_input", message, hint="see engine_info.py --help"))
        sys.exit(EXIT["bad_input"])


def _librosa_info():
    import librosa

    return {
        "name": "librosa",
        "version": librosa.__version__,
        "license": "ISC",
        "modelVersions": {},
        "confidenceKind": "correlation",
        "contractVersion": CONTRACT_VERSION,
        "capabilities": ["key", "chords"],
    }


def run(argv):
    p = _ContractArgumentParser(prog="engine_info.py")
    p.add_argument("--engine", default="librosa", choices=["librosa", "madmom", "essentia"])
    p.add_argument("--json", action="store_true")
    args = p.parse_args(argv)

    try:
        if args.engine not in IMPLEMENTED:
            raise EngineUnavailable(
                f"engine '{args.engine}' is not available yet",
                hint="run `chord setup` or use --engine librosa",
            )
        write_result(_librosa_info())
        return EXIT["ok"]
    except EngineFailure as e:
        write_result(error_envelope(e.kind, e.detail, e.hint))
        return ERROR_KIND_EXIT[e.kind]
    except Exception as e:  # noqa: BLE001 — e.g. librosa import failure -> engine_unavailable
        write_result(error_envelope("engine_unavailable", f"{type(e).__name__}: {e}"))
        return EXIT["engine_unavailable"]


if __name__ == "__main__":
    sys.exit(run(sys.argv[1:]))
