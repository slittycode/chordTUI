#!/usr/bin/env python3
"""Real analysis sidecar — the producer side of the JSON contract (src/core/types.ts).

Usage:
  analyze.py --engine librosa|madmom|essentia --file PATH [--json]

  stdout : exactly ONE JSON object — an Analysis, or {"error": {...}}.
  stderr : NDJSON progress events, one per pipeline stage.
  exit   : 0 ok / 2 bad input / 3 engine unavailable / 4 analysis-or-internal failure.

librosa is the always-available clean core. madmom is opt-in (its NC, install-fragile package
must be installed); essentia has no engine module yet. Both parse as valid choices but return
engine_unavailable (exit 3) when not actually usable. See is_available().
"""
import argparse
import importlib
import importlib.util
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

# engine name -> its analysis module. librosa ships in the clean core; madmom ships a module
# but is usable only when its package is also installed (registry-gated, NOT import-gated:
# the module existing on disk is necessary but not sufficient).
ENGINE_MODULES = {"librosa": "engines.librosa_engine", "madmom": "engines.madmom_engine"}


def is_available(engine):
    """True iff `engine` has both an analysis module AND (for opt-in tiers) its package."""
    module = ENGINE_MODULES.get(engine)
    if module is None:
        return False
    if engine == "librosa":
        return True  # clean core, always installed
    if importlib.util.find_spec(module) is None:
        return False
    return importlib.util.find_spec(engine) is not None  # the underlying library (e.g. madmom)


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
        if not is_available(args.engine):
            raise EngineUnavailable(
                f"engine '{args.engine}' is not available",
                hint="run `chord setup` or use --engine librosa",
            )
        if not os.path.isfile(args.file):
            raise BadInput(f"file not found: {args.file}", hint="check the path")

        engine = importlib.import_module(ENGINE_MODULES[args.engine])

        def on_stage(stage):
            emit_progress(stage, STAGES.index(stage), len(STAGES))

        write_result(engine.analyze(args.file, on_stage))
        return EXIT["ok"]
    except EngineFailure as e:
        write_result(error_envelope(e.kind, e.detail, e.hint))
        return ERROR_KIND_EXIT[e.kind]
    except Exception as e:  # noqa: BLE001 — any unexpected fault maps to a contract error
        write_result(error_envelope("internal", f"{type(e).__name__}: {e}"))
        return EXIT["analysis_failed"]


if __name__ == "__main__":
    sys.exit(run(sys.argv[1:]))
