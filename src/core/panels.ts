// src/core/panels.ts — capability-gated panel visibility (pure, no I/O, no React).
//
// Encodes the contract rule from PLAN.md §3 / types.ts: a sub-panel renders IFF its capability
// is advertised in engineCapabilities[] AND the corresponding field is non-null. A `null`
// advanced field means "this engine could not compute it" → the sub-feature is removed, never
// faked. Kept pure so it can be unit-tested without a renderer (the safety net beside the
// testRender component tests).

import type { Analysis } from "./types";

export interface VisiblePanels {
  /** Top-3 alternative keys. */
  keyCandidates: boolean;
  /** Beat onset times. */
  beats: boolean;
  /** Downbeat onset times. */
  downbeats: boolean;
  /** e.g. "4/4". */
  timeSignature: boolean;
  /** The chord timeline + progression. */
  chords: boolean;
}

/**
 * Which advanced panels an Analysis supports. `key` is always present (non-nullable in the
 * contract) so it is never gated and not included here. `extendedChords` is refused at MVP, so
 * it never appears regardless of capabilities — the disabled toggle is rendered unconditionally
 * by ProgressionPanel, not driven by this map.
 */
export function visiblePanels(analysis: Analysis): VisiblePanels {
  const caps = analysis.engineCapabilities;
  return {
    keyCandidates: caps.includes("keyCandidates") && analysis.keyCandidates !== null,
    beats: caps.includes("beats") && analysis.beats !== null,
    downbeats: caps.includes("downbeats") && analysis.downbeats !== null,
    timeSignature: caps.includes("timeSignature") && analysis.timeSignature !== null,
    // chords is a required, non-nullable array; the capability alone gates it.
    chords: caps.includes("chords"),
  };
}
