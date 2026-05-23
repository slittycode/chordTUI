// Header — title + the engine/mode/contract status line. Shows [MOCK] when the resolved sidecar
// is the bundled mock, so fake on-screen data is always labelled.

import { CURRENT_CONTRACT_VERSION } from "../core/types";
import type { EngineInfo } from "../core/types";
import type { AnalysisMode } from "../hooks/useAnalysis";
import { C } from "./theme";

export function Header({
  engine,
  mode,
  isMock,
}: {
  engine: EngineInfo | null;
  mode: AnalysisMode;
  isMock: boolean;
}) {
  const right =
    (isMock ? "[MOCK] " : "") +
    (engine ? `${engine.name} ${engine.version} (${engine.license})` : "no engine yet") +
    ` · mode: ${mode} · v${CURRENT_CONTRACT_VERSION}`;
  return (
    <box flexDirection="row" justifyContent="space-between" paddingX={1} backgroundColor={C.panel}>
      <text fg={C.accent}>chord — key / chords / progression</text>
      <text fg={C.dim}>{right}</text>
    </box>
  );
}
