#!/usr/bin/env python3
"""Cheap capability probe — the engine-info side of the JSON contract.

Decodes no audio. Prints an EngineInfoResponse (engine/engine-info.schema.json) so the
frontend can build cache keys and discover capabilities without a full analysis.

Usage:
  engine_info.py --engine librosa|madmom|essentia [--json]

  exit 0 + EngineInfoResponse on stdout for an available engine; exit 3 + an
  engine_unavailable envelope for one that is not installed.
"""
import argparse
import sys
import warnings

warnings.filterwarnings("ignore")

from analyze import is_available  # noqa: E402 — share the one registry-availability check
from protocol import (  # noqa: E402
    CONTRACT_VERSION,
    ERROR_KIND_EXIT,
    EXIT,
    EngineFailure,
    EngineUnavailable,
    error_envelope,
    write_result,
)


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


def _btc_info():
    # Reuse the engine's block so engine-info and analyze report identical version + modelVersions
    # (the cache staleness check depends on it). Advertises the large-voca (extended) default.
    from engines.btc_engine import engine_block

    return {
        **engine_block(large_voca=True),
        "contractVersion": CONTRACT_VERSION,
        "capabilities": ["key", "chords"],
    }


_INFO = {"librosa": _librosa_info, "btc": _btc_info}


def run(argv):
    p = _ContractArgumentParser(prog="engine_info.py")
    p.add_argument("--engine", default="librosa", choices=["librosa", "essentia", "btc"])
    p.add_argument("--json", action="store_true")
    args = p.parse_args(argv)

    try:
        if not is_available(args.engine):
            raise EngineUnavailable(
                f"engine '{args.engine}' is not available",
                hint="run `chord setup` or use --engine librosa",
            )
        write_result(_INFO[args.engine]())
        return EXIT["ok"]
    except EngineFailure as e:
        write_result(error_envelope(e.kind, e.detail, e.hint))
        return ERROR_KIND_EXIT[e.kind]
    except Exception as e:  # noqa: BLE001 — e.g. librosa import failure -> engine_unavailable
        write_result(error_envelope("engine_unavailable", f"{type(e).__name__}: {e}"))
        return EXIT["engine_unavailable"]


if __name__ == "__main__":
    sys.exit(run(sys.argv[1:]))
