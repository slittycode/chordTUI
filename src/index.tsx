#!/usr/bin/env bun
// chordTUI entrypoint.
//
// This branch (Milestone A) is contract-only: the Python analysis sidecar and the
// OpenTUI frontend arrive in Milestones B/C. This skeleton makes the advertised
// `chord` bin / `bun run dev` real and honest — it routes commands and reports what
// is not built yet, rather than crashing with "Module not found".

import { CURRENT_CONTRACT_VERSION } from "./core/types";

const [command] = process.argv.slice(2);

const HELP = `chord — terminal chord / key / progression detector (contract v${CURRENT_CONTRACT_VERSION})

Usage:
  chord analyze <file>   analyze an audio file        (Milestone B/C)
  chord                  interactive TUI              (Milestone B)
  chord doctor           report engine/ffmpeg status  (Milestone B)
  chord setup            install the analysis engine  (Milestone B/C)
  chord --help           show this help

This branch ships the locked frontend<->engine contract + scaffold only. See PLAN.md.`;

function notYet(what: string): never {
  console.error(`${what} is not implemented yet (Milestone B/C). See PLAN.md.`);
  process.exit(1);
}

switch (command) {
  case undefined:
  case "--help":
  case "-h":
  case "help":
    console.log(HELP);
    break;
  case "analyze":
  case "doctor":
  case "setup":
  case "engine-info":
    notYet(`"chord ${command}"`);
    break;
  default:
    console.error(`Unknown command: "${command}"\nRun "chord --help".`);
    process.exit(2);
}
