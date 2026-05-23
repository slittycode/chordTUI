// src/components/theme.ts — the one place TUI colors are defined (hex, OpenTUI fg/bg format).
// Chord-quality colors are NOT here — those come from music.ts `colorForQuality` (the contract-
// aware mapping the timeline uses).

export const C = {
  bg: "#1a1a2e",
  panel: "#16213e",
  fg: "#c0caf5",
  dim: "#565f89",
  accent: "#7aa2f7",
  good: "#4ade80",
  warn: "#fbbf24",
  bad: "#f87171",
  border: "#3b4261",
  borderFocus: "#7aa2f7",
} as const;
