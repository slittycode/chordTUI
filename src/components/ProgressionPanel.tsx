// ProgressionPanel — the chord progression as a compact "label (roman) → …" line (roman numerals
// are in-key-only, computed TS-side; out-of-key chords get no numeral). The "extended chords"
// line reflects the analysis's actual vocabulary: "on" with the btc engine (7ths/sus/etc.), "off"
// when an engine only produced triads — stated honestly, never faked.

import type { Analysis } from "../core/types";
import { collapseProgression, formatChordLabel, romanNumeral } from "../core/music";
import { C } from "./theme";

export function ProgressionPanel({ analysis }: { analysis: Analysis }) {
  const cells = collapseProgression(analysis.chords).map((run) => {
    const label = formatChordLabel(run, analysis.key);
    const rn = romanNumeral(run.root, run.quality, analysis.key);
    return rn ? `${label} (${rn})` : label;
  });
  const body = cells.length ? cells.join("  →  ") : "(none)";
  const extendedOn = analysis.vocabulary === "extended";

  return (
    <box
      flexDirection="column"
      border
      borderStyle="single"
      borderColor={C.border}
      paddingX={1}
      title="PROGRESSION"
    >
      <text fg={C.fg}>{body}</text>
      <text fg={C.dim}>
        {extendedOn
          ? `extended chords: on — 7ths/sus/etc. via ${analysis.engine.name}`
          : "extended chords: off — triads only (install the btc engine for 7ths)"}
      </text>
    </box>
  );
}
