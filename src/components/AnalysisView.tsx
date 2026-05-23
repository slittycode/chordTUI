// AnalysisView — the capability-gated composition of result panels. Pure presentational: given an
// Analysis it renders KeyPanel always, and the chord timeline + progression only when the engine
// advertises the "chords" capability. This is the deterministic test seam (no driver, no async):
// the sparse/full component tests render it directly with a fixed Analysis.

import type { Analysis } from "../core/types";
import { visiblePanels } from "../core/panels";
import { KeyPanel } from "./KeyPanel";
import { ChordTimeline } from "./ChordTimeline";
import { ProgressionPanel } from "./ProgressionPanel";

export function AnalysisView({
  analysis,
  timelineFocused,
}: {
  analysis: Analysis | null;
  timelineFocused: boolean;
}) {
  if (!analysis) return null; // App owns the holding/error view while there's no result yet
  const show = visiblePanels(analysis);
  return (
    <box flexDirection="column" flexGrow={1}>
      <KeyPanel analysis={analysis} show={show} />
      {show.chords ? <ChordTimeline analysis={analysis} focused={timelineFocused} /> : null}
      {show.chords ? <ProgressionPanel analysis={analysis} /> : null}
    </box>
  );
}
