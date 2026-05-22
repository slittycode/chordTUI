#!/usr/bin/env bun
// chordTUI entrypoint — dual-mode router.
//
// args → CLI commands (analyze / engine-info / doctor / setup). No args → interactive TUI,
// not implemented until the TUI milestone.
//
// Exit codes are set via `process.exitCode`, NOT `process.exit()`: defaultIO writes to
// process.stdout, which is asynchronous on a pipe, and `process.exit()` can drop a buffered
// `--json` write before it flushes. Assigning `process.exitCode` lets the event loop drain
// (timers cleared, child reaped) and flush stdout first.

import { CURRENT_CONTRACT_VERSION } from "./core/types";
import type { EngineName } from "./core/types";
import { cmdAnalyze, cmdDoctor, cmdEngineInfo, cmdSetup } from "./cli/commands";

const ENGINE_NAMES: readonly string[] = ["librosa", "madmom", "essentia"];

const HELP = `chord — terminal chord / key / progression detector (contract v${CURRENT_CONTRACT_VERSION})

Usage:
  chord analyze <file> [--engine librosa|madmom|essentia] [--json]
                         analyze an audio file (key + chords + progression)
  chord engine-info [--engine X] [--json]
                         print the engine's capabilities / versions
  chord doctor           report engine / python / ffmpeg / librosa / madmom status
  chord setup            install the analysis engine (not yet implemented)
  chord                  interactive TUI (not yet implemented)
  chord --help           show this help

Notes:
  • With no real engine installed, analyze uses a bundled MOCK (sample data) only in an
    interactive terminal; piped / --json output refuses (run \`chord setup\`).`;

interface ParsedFlags {
  positionals: string[];
  engine?: string;
  json: boolean;
  unknownFlag?: string;
}

/** Single left-to-right pass so flags and the positional file can interleave. */
function parseFlags(args: string[]): ParsedFlags {
  const positionals: string[] = [];
  let engine: string | undefined;
  let json = false;
  let unknownFlag: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;
    if (a === "--json") {
      json = true;
    } else if (a === "--engine") {
      i += 1;
      engine = args[i]; // may be undefined; validated by the caller
    } else if (a.startsWith("--")) {
      unknownFlag ??= a;
    } else {
      positionals.push(a);
    }
  }
  return { positionals, engine, json, unknownFlag };
}

/** Returns the validated engine, or null if invalid (message already written). */
function checkEngine(engine: string | undefined): EngineName | undefined | null {
  if (engine === undefined) return undefined;
  if (ENGINE_NAMES.includes(engine)) return engine as EngineName;
  process.stderr.write(`Unknown engine "${engine}". Choose one of: ${ENGINE_NAMES.join(", ")}.\n`);
  return null;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const rest = argv.slice(1);

  switch (command) {
    case undefined:
      process.stderr.write(
        "Interactive TUI is not implemented yet. Try `chord analyze <file>` or `chord --help`.\n",
      );
      return 1;

    case "--help":
    case "-h":
    case "help":
      process.stdout.write(HELP + "\n");
      return 0;

    case "analyze": {
      const f = parseFlags(rest);
      if (f.unknownFlag) {
        process.stderr.write(`Unknown option "${f.unknownFlag}".\n`);
        return 2;
      }
      const file = f.positionals[0];
      if (!file) {
        process.stderr.write(
          "Usage: chord analyze <file> [--engine librosa|madmom|essentia] [--json]\n",
        );
        return 2;
      }
      const engine = checkEngine(f.engine);
      if (engine === null) return 2;
      return cmdAnalyze({ file, engine, json: f.json });
    }

    case "engine-info": {
      const f = parseFlags(rest);
      if (f.unknownFlag) {
        process.stderr.write(`Unknown option "${f.unknownFlag}".\n`);
        return 2;
      }
      const engine = checkEngine(f.engine);
      if (engine === null) return 2;
      return cmdEngineInfo({ engine, json: f.json });
    }

    case "doctor":
      return cmdDoctor({});

    case "setup":
      return cmdSetup({});

    default:
      process.stderr.write(`Unknown command: "${command}"\nRun "chord --help".\n`);
      return 2;
  }
}

process.exitCode = await main();
