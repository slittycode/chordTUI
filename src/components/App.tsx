// App — the stateful container. Owns the useAnalysis run-state machine and a tiny view flag
// (picker vs results). Layout is a flex column: Header (top) / middle region / StatusBar (bottom).
//
// Keyboard is mode-gated to avoid the global-handler-vs-focused-input bug: OpenTUI fires global
// useKeyboard handlers BEFORE the focused renderable, so while the picker's <select>/<input> is
// live we listen ONLY for escape and let letters/arrows reach the control. Bare-letter commands
// (q/f/m) are active only in the results view. Repeats are ignored so a held key can't burst.

import { useState } from "react";
import { useKeyboard, useRenderer } from "@opentui/react";

import { useAnalysis } from "../hooks/useAnalysis";
import type { EngineDriver } from "../hooks/useAnalysis";
import { Header } from "./Header";
import { FilePicker } from "./FilePicker";
import { AnalysisView } from "./AnalysisView";
import { StatusBar } from "./StatusBar";
import { C } from "./theme";

export function App({ driver }: { driver?: EngineDriver } = {}) {
  const renderer = useRenderer();
  const { state, analyze, cancel, isMock, mode, toggleMode } = useAnalysis(driver);
  const [appView, setAppView] = useState<"picker" | "results">("picker");

  const running = state.phase === "running-preview" || state.phase === "running-upgrade";

  useKeyboard((key) => {
    if (key.repeated) return;
    if (appView === "picker") {
      if (key.name === "escape" && running) cancel();
      return; // let the focused select/input own letters / arrows / enter
    }
    // results view
    if (key.name === "q") {
      renderer.destroy();
    } else if (key.name === "escape") {
      if (running) cancel();
      else setAppView("picker");
    } else if (key.name === "f") {
      setAppView("picker");
    } else if (key.name === "m" && !running) {
      toggleMode();
    }
  });

  const onPick = (absPath: string) => {
    setAppView("results");
    analyze(absPath);
  };

  return (
    <box flexDirection="column" height="100%" backgroundColor={C.bg}>
      <Header engine={state.analysis?.engine ?? null} mode={mode} isMock={isMock} />

      <box flexGrow={1} flexDirection="column">
        {appView === "picker" ? (
          <FilePicker onPick={onPick} focused={true} />
        ) : state.analysis !== null ? (
          <AnalysisView analysis={state.analysis} timelineFocused={true} />
        ) : state.phase === "error" ? (
          <box flexGrow={1} paddingX={1}>
            <text fg={C.bad}>
              analysis failed: {state.error?.detail ?? "unknown error"}
              {state.error?.hint ? ` (${state.error.hint})` : ""}
            </text>
          </box>
        ) : (
          <box flexGrow={1} paddingX={1}>
            <text fg={C.dim}>analyzing{state.stage ? `… ${state.stage}` : "…"}</text>
          </box>
        )}
      </box>

      <StatusBar state={state} />
    </box>
  );
}
