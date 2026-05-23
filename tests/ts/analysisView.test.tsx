// tests/ts/analysisView.test.tsx — capability-gated rendering, end to end through OpenTUI.
//
// Renders AnalysisView with the real mock fixtures (sparse vs full) and asserts on the captured
// char frame. Sparse must HIDE the advanced panels; full must SHOW candidates / beats / time
// signature. (Assertions target <box>+<text> content — the probe confirmed <select>/<scrollbox>
// content does not flatten into captureCharFrame, which is why those are not asserted here.)

import { test, expect } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { createElement } from "react";
import { AnalysisView } from "../../src/components/AnalysisView";
import { validateAnalysis } from "../../src/core/validate";
import type { Analysis } from "../../src/core/types";

const MOCK = "engine/mock_sidecar.py";

function mock(payload: "sparse" | "full"): Analysis {
  const p = Bun.spawnSync(["python3", MOCK, "analyze", "--payload", payload]);
  return validateAnalysis(JSON.parse(p.stdout.toString()));
}

async function frameFor(analysis: Analysis): Promise<string> {
  const { renderOnce, captureCharFrame } = await testRender(
    createElement(AnalysisView, { analysis, timelineFocused: false }),
    { width: 100, height: 30 },
  );
  // Settle the tree before snapshotting (see the plan's verified flush ritual).
  await new Promise((r) => setTimeout(r, 20));
  await Promise.resolve();
  await renderOnce();
  return captureCharFrame();
}

test("sparse payload hides the advanced panels (key + progression still render)", async () => {
  const frame = await frameFor(mock("sparse"));
  expect(frame).toContain("C major"); // key always renders
  expect(frame).not.toContain("Candidates");
  expect(frame).not.toContain("beats");
  expect(frame).not.toContain("4/4");
});

test("full payload shows candidates, beats, and the time signature", async () => {
  const frame = await frameFor(mock("full"));
  expect(frame).toContain("Candidates");
  expect(frame).toContain("beats");
  expect(frame).toContain("4/4");
});
