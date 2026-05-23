// ProgressionPanel — the chord progression as a compact "label (roman) → …" line (roman numerals
// are in-key-only, computed TS-side; out-of-key chords get no numeral). Also the home of the
// always-disabled "extended chords" affordance: rendered as a plain text line (not a control), so
// the honest "triads only at MVP" limitation is visible without pretending it's toggleable.

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
        extended chords: off — triads only at this version; extended chords need a model that isn't
        wired up yet.
      </text>
    </box>
  );
}
