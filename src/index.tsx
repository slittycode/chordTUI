#!/usr/bin/env bun
// chordTUI entrypoint — dual-mode router.
//
// args → CLI commands (analyze / engine-info / doctor / setup). No args → interactive OpenTUI
// app (mounted lazily so CLI usage never loads the renderer).
//
// Exit codes are set via `process.exitCode`, NOT `process.exit()`: defaultIO writes to
// process.stdout, which is asynchronous on a pipe, and `process.exit()` can drop a buffered
// `--json` write before it flushes. Assigning `process.exitCode` lets the event loop drain
// (timers cleared, child reaped) and flush stdout first. The TUI relies on the same discipline:
// it mounts and `main()` returns 0, but the renderer keeps the loop alive until `renderer.destroy()`.

import { CURRENT_CONTRACT_VERSION, EXIT } from "./core/types";
import type { EngineName } from "./core/types";
import { cmdAnalyze, cmdDoctor, cmdEngineInfo, cmdSetup } from "./cli/commands";

// A runtime crash inside the mounted TUI would otherwise be masked by the no-arg branch's
// `return 0`. Capture it as a nonzero exit code WITHOUT calling process.exit() (keeps the
// stdout-flush discipline above). CLI commands complete synchronously and never reach here.
process.on("uncaughtException", (err) => {
  process.exitCode = EXIT.analysisFailed;
  process.stderr.write(`Fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
});

const ENGINE_NAMES: readonly string[] = ["librosa", "btc", "essentia"];

const HELP = `chordtui — terminal chord / key / progression detector (contract v${CURRENT_CONTRACT_VERSION})

Usage:
  chordtui analyze <file> [--engine librosa|btc] [--json] [--no-cache]
                         analyze an audio file (key + chords + progression)
  chordtui engine-info [--engine X] [--json]
                         print the engine's capabilities / versions
  chordtui doctor        per-engine table: installed / working (ran on a WAV) / license / default
  chordtui setup [--engine librosa|btc] [--no-btc]
                         install the clean librosa core; by default also install the btc engine
  chordtui               launch the interactive TUI
  chordtui --help        show this help

Notes:
  • \`chord\` is an alias for \`chordtui\` (both are installed by \`bun link\`).
  • Without --engine, analyze uses btc (extended chords, ~80% accuracy) when installed, else librosa.
  • Results are cached per audio file + engine; re-runs are instant (--no-cache to skip).
  • With no real engine installed, analyze uses a bundled MOCK (sample data) only in an
    interactive terminal; piped / --json output refuses (run \`chordtui setup\`).`;

interface ParsedFlags {
  positionals: string[];
  engine?: string;
  json: boolean;
  noCache: boolean;
  unknownFlag?: string;
}

/** Single left-to-right pass so flags and the positional file can interleave. */
function parseFlags(args: string[]): ParsedFlags {
  const positionals: string[] = [];
  let engine: string | undefined;
  let json = false;
  let noCache = false;
  let unknownFlag: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;
    if (a === "--json") {
      json = true;
    } else if (a === "--no-cache") {
      noCache = true;
    } else if (a === "--engine") {
      i += 1;
      engine = args[i]; // may be undefined; validated by the caller
    } else if (a.startsWith("--")) {
      unknownFlag ??= a;
    } else {
      positionals.push(a);
    }
  }
  return { positionals, engine, json, noCache, unknownFlag };
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
    case undefined: {
      // Lazy-load the renderer + React tree so CLI usage never pays for OpenTUI.
      const { createElement } = await import("react");
      const { createCliRenderer } = await import("@opentui/core");
      const { createRoot } = await import("@opentui/react");
      const { App } = await import("./components/App");
      const { ErrorBoundary } = await import("./components/ErrorBoundary");
      const renderer = await createCliRenderer();
      // createElement (not JSX) for the class boundary: OpenTUI's JSX.ElementClass and React 19's
      // class-component constructor typing don't line up, but createElement types it fine.
      createRoot(renderer).render(createElement(ErrorBoundary, null, createElement(App)));
      return EXIT.ok; // renderer keeps the event loop alive; exits on renderer.destroy()
    }

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
          "Usage: chord analyze <file> [--engine librosa|btc] [--json] [--no-cache]\n",
        );
        return 2;
      }
      const engine = checkEngine(f.engine);
      if (engine === null) return 2;
      return cmdAnalyze({ file, engine, json: f.json, noCache: f.noCache });
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
      return cmdSetup({ argv: rest });

    default:
      process.stderr.write(`Unknown command: "${command}"\nRun "chord --help".\n`);
      return 2;
  }
}

process.exitCode = await main();
