// tests/ts/app.test.tsx — App-level wiring that's cheap to assert deterministically.
//
// The keyboard quit paths call renderer.destroy() (a teardown side effect that's impractical to
// assert here), but the user-facing honesty fix — the StatusBar hint being context-appropriate —
// is a plain render assertion. A stub driver keeps this from spawning Python.

import { test, expect } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { createElement } from "react";
import { App } from "../../src/components/App";
import type { EngineDriver } from "../../src/hooks/useAnalysis";
import { EngineUnavailableError } from "../../src/core/engine";

const stubDriver: EngineDriver = {
  isMock: false,
  engineInfo: async () => {
    throw new EngineUnavailableError("none in test");
  },
  analyze: async () => {
    throw new EngineUnavailableError("none in test");
  },
};

test("the picker shows a picker-appropriate hint, not the results-view commands", async () => {
  const { renderOnce, captureCharFrame } = await testRender(
    createElement(App, { driver: stubDriver }),
    { width: 90, height: 24 },
  );
  await new Promise((r) => setTimeout(r, 20));
  await Promise.resolve();
  await renderOnce();

  const frame = captureCharFrame();
  expect(frame).toContain("OPEN AN AUDIO FILE");
  expect(frame).toContain("esc quit"); // honest: esc quits from the picker
  expect(frame).not.toContain("f file"); // the results-only hint must not appear here
});
