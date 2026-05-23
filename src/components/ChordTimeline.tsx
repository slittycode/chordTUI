// ChordTimeline — a horizontal, time-proportional view of the chord track. Each collapsed run is
// a colored cell whose width is proportional to its duration (colored by quality via music.ts).
// Horizontal-scrolls when focused. Visual only — the assertable progression text lives in
// ProgressionPanel, since <select>/<scrollbox> content does not flatten into the test snapshot.

import type { Analysis } from "../core/types";
import { collapseProgression, colorForQuality, formatChordLabel } from "../core/music";
import { C } from "./theme";

const CHARS_PER_SEC = 4; // horizontal scale; cells scroll if the row overflows the viewport
const MIN_CELL = 3;

export function ChordTimeline({ analysis, focused }: { analysis: Analysis; focused: boolean }) {
  const runs = collapseProgression(analysis.chords);
  return (
    <box
      flexDirection="column"
      border
      borderStyle="single"
      borderColor={focused ? C.borderFocus : C.border}
      title="CHORDS (timeline)"
      height={4}
    >
      <scrollbox scrollX focused={focused}>
        <box flexDirection="row">
          {runs.map((run, i) => {
            const width = Math.max(MIN_CELL, Math.round((run.end - run.start) * CHARS_PER_SEC));
            return (
              <box key={i} width={width} backgroundColor={colorForQuality(run.quality)} alignItems="center">
                <text fg="#000000">{formatChordLabel(run, analysis.key)}</text>
              </box>
            );
          })}
        </box>
      </scrollbox>
    </box>
  );
}
