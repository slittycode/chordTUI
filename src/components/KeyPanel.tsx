// KeyPanel — the detected key + confidence (interpreted per the engine's confidenceKind), plus
// the capability-gated advanced lines (key candidates, beat/downbeat counts, time signature).
// The literal labels "Candidates", "beats", and the raw time-signature string are load-bearing:
// the component tests assert on them, and they are absent under a sparse (librosa) result.

import type { Analysis } from "../core/types";
import type { VisiblePanels } from "../core/panels";
import { confidenceMeaning, formatKey } from "../core/music";
import { C } from "./theme";

export function KeyPanel({ analysis, show }: { analysis: Analysis; show: VisiblePanels }) {
  const { key, engine } = analysis;

  const meta: string[] = [];
  if (show.beats && analysis.beats) meta.push(`beats: ${analysis.beats.length}`);
  if (show.downbeats && analysis.downbeats) meta.push(`downbeats: ${analysis.downbeats.length}`);
  if (show.timeSignature && analysis.timeSignature) meta.push(analysis.timeSignature);

  return (
    <box flexDirection="column" border borderStyle="single" borderColor={C.border} paddingX={1} title="KEY">
      <text fg={C.fg}>
        {formatKey(key)}  ·  confidence {key.confidence.toFixed(2)} ({confidenceMeaning(engine.confidenceKind)})
      </text>

      {show.keyCandidates && analysis.keyCandidates ? (
        <box flexDirection="column">
          <text fg={C.dim}>Candidates</text>
          {analysis.keyCandidates.map((c, i) => (
            <text key={i} fg={C.fg}>
              {"  "}
              {formatKey(c)} ({c.confidence.toFixed(2)})
            </text>
          ))}
        </box>
      ) : null}

      {meta.length ? <text fg={C.dim}>{meta.join("  ·  ")}</text> : null}
    </box>
  );
}
