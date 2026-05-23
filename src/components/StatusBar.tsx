// StatusBar — the run-state line (phase + live progress stage, the keep-preview upgrade note, or
// the error with its hint) plus the global key hints.

import type { AnalysisState } from "../hooks/useAnalysis";
import { C } from "./theme";

function statusLine(state: AnalysisState): { text: string; color: string } {
  switch (state.phase) {
    case "idle":
      return { text: "ready", color: C.dim };
    case "running-preview":
      return { text: `analyzing… ${state.stage ?? ""}`.trim(), color: C.accent };
    case "done-preview":
      return state.upgradeNote
        ? { text: state.upgradeNote, color: C.warn }
        : { text: "preview ready", color: C.good };
    case "running-upgrade":
      return { text: `preview ready ↑ upgrading… ${state.stage ?? ""}`.trim(), color: C.accent };
    case "done-upgrade":
      return { text: "done", color: C.good };
    case "cancelling":
      return { text: "cancelling…", color: C.warn };
    case "error": {
      const e = state.error;
      const hint = e?.hint ? ` (${e.hint})` : "";
      return { text: `error: ${e?.detail ?? "failed"}${hint}`, color: C.bad };
    }
  }
  return { text: String(state.phase), color: C.dim }; // unreachable; keeps TS happy
}

export function StatusBar({ state, hints }: { state: AnalysisState; hints: string }) {
  const s = statusLine(state);
  return (
    <box flexDirection="row" justifyContent="space-between" paddingX={1} backgroundColor={C.panel}>
      <text fg={s.color}>{s.text}</text>
      <text fg={C.dim}>{hints}</text>
    </box>
  );
}
