// tests/ts/cancel.test.tsx — cancel() aborts the in-flight run's signal.
//
// A sentinel harness mounts useAnalysis with a FAKE driver whose analyze() never resolves but
// captures the AbortSignal and rejects with EngineAbortError when it fires. The harness publishes
// {analyze, cancel} to a sink the test holds, so the test drives the hook directly (decoupled from
// App's keymap). We assert the captured signal flips to aborted after cancel().

import { test, expect } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, createElement } from "react";
import { useAnalysis } from "../../src/hooks/useAnalysis";
import type { EngineDriver } from "../../src/hooks/useAnalysis";
import type { RunEngineResult } from "../../src/core/engine";
import { EngineAbortError, EngineUnavailableError } from "../../src/core/engine";

interface Capture {
  signal?: AbortSignal;
}
interface Sink {
  analyze?: (file: string) => void;
  cancel?: () => void;
}

function fakeDriver(capture: Capture): EngineDriver {
  return {
    isMock: true,
    // Mount probe → unavailable, so upgradeAvailable stays false (no second leg to worry about).
    engineInfo: async () => {
      throw new EngineUnavailableError("no madmom in test");
    },
    // Never resolves; rejects with EngineAbortError when the run is cancelled.
    analyze: (_engine, _file, { signal }) => {
      capture.signal = signal;
      return new Promise<RunEngineResult>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new EngineAbortError("cancelled")), { once: true });
      });
    },
  };
}

function Harness({ driver, sink }: { driver: EngineDriver; sink: Sink }) {
  const a = useAnalysis(driver);
  sink.analyze = (file: string) => a.analyze(file);
  sink.cancel = a.cancel;
  return createElement("text", null, a.state.phase);
}

// Run `action` (if any) and let its synchronous dispatches (ANALYZE_REQUESTED, CANCEL_REQUESTED)
// AND the resulting async ones (PREVIEW_DONE/ABORTED) settle — all inside one act() batch so React
// doesn't warn about state updates outside an act() boundary.
const flush = async (renderOnce: () => Promise<void>, action?: () => void) => {
  await act(async () => {
    action?.();
    await new Promise((r) => setTimeout(r, 10));
    await Promise.resolve();
    await renderOnce();
  });
};

test("cancel() walks the abort: the in-flight run's signal becomes aborted", async () => {
  const capture: Capture = {};
  const sink: Sink = {};
  const { renderOnce } = await testRender(
    createElement(Harness, { driver: fakeDriver(capture), sink }),
    { width: 40, height: 6 },
  );
  await flush(renderOnce);

  await flush(renderOnce, () => sink.analyze!("song.wav"));
  expect(capture.signal).toBeDefined();
  expect(capture.signal!.aborted).toBe(false);

  await flush(renderOnce, () => sink.cancel!());
  expect(capture.signal!.aborted).toBe(true);
});
