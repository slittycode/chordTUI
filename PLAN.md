# chordTUI — Key, Chord & Progression Recognition TUI

> **Revised after a 9-agent (3×3) Opus review.** The headline change: the default
> engine flips from madmom to **librosa**, driven by two verified facts the first
> draft got wrong — madmom's pretrained models are **CC-BY-NC-SA (NonCommercial)**,
> not MIT, and madmom 0.16.1 (Nov 2018, sdist-only, ≤Py3.7) has a **<70% clean-install
> rate even fully pinned**. See "Changes from the previous draft" and "Open decisions".

## Decisions (resolved with the user)

| # | Decision | Answer | Consequence |
|---|----------|--------|-------------|
| **a** | Commercial or personal use? | **Personal / non-commercial** | madmom (CC-BY-NC-SA models) **and** essentia (AGPL) are admissible. Your code stays MIT; NC/AGPL deps carry notices. |
| **b** | Platform scope for v1? | **macOS-arm64 only** | Single target → testable/shippable. `bun run` source path stays cross-platform. Compiled-binary-with-native-deps remains a Phase-0 probe. |
| **d** | Is a ~55% librosa floor acceptable out-of-box? | **No — must hit ~80%** | **madmom is the v1 DEFAULT accuracy engine**, not an afterthought. librosa is demoted to the fast *preview* tier + the fallback-of-last-resort. |
| **c/e** | Keep madmom / auto-promote? | **Yes (follows from a+d)** | madmom is the default; one-time NC notice on first use. essentia stays available (personal use) but isn't primary (weaker than madmom). |

> **Why this is now coherent (the key insight):** "must hit ~80%" would normally
> collide with "madmom installs <70% of the time." But that statistic is about
> *strangers' machines*. For a **personal, macOS-arm64-only** tool, madmom only has
> to install on **one machine — yours**. So madmom-as-default is viable **iff the real
> install probe succeeds on your machine.** That probe is therefore the #1 de-risk and
> the literal first action (Phase 0, before any other code). If it fails even with the
> tight pins, the fallbacks in priority order are: (1) fix the install (try a different
> Python/numpy/Cython pin combo or essentia, AGPL-ok for personal use), (2) only then
> fall back to the librosa floor and renegotiate the ~80% expectation.

---

## 1. Context

chordTUI is a macOS terminal tool: you point it at an audio file (MP3 / FLAC / WAV)
and it tells you the song's **key**, its **chords over time**, and the **chord
progression**. Triads + key by default. **Accuracy is priority #1.** Public repo:
`slittycode/chordTUI`.

**Architecture (decided):** a TypeScript/Bun + OpenTUI frontend on top of a separate
Python analysis sidecar that does the audio ML, communicating via a strict
JSON-over-`Bun.spawn` contract. The split is deliberate — the accurate, maintained
chord/key engines live in Python; OpenTUI gives a fast, modern TUI. We **depend on
`@opentui/react` as a library** and customize app-side; no fork.

**Why this is a redesign (the corrections that prompted it):**
1. **Licensing reality.** madmom's *code* is BSD, but its *pretrained chord/key
   models* — which produce the accuracy — are **CC-BY-NC-SA 4.0 (NonCommercial)**
   and are required to run the recognizers. essentia is **AGPL-3.0**. The previous
   plan's "madmom MIT" was wrong.
2. **Install reality.** madmom 0.16.1 (Nov 2018, sdist-only) targets ≤Py3.7, uses
   `np.float`/Cython<3, and gets **<70% clean-install success even fully pinned**
   (Py3.9 / numpy<1.24 / scipy<1.13 / Cython<3, or git main). It cannot be the
   default dependency. The previous "Py3.10–3.12 / numpy<2" was wrong.
3. **Therefore (given the user wants ~80% out-of-box, personal use, single
   platform):** **madmom is the v1 DEFAULT accuracy engine** — viable because it only
   has to install on one machine (yours). **librosa (ISC, always installs) is demoted
   to the fast *preview* tier** (shown instantly while madmom runs) **and the
   fallback** if the madmom probe fails. essentia is an opt-in alternative (AGPL,
   acceptable for personal use; weaker than madmom so not primary).

**Honest accuracy expectation (state up front, and in the README):**
1. **madmom (default):** deep-learning chord (CRF over deep chroma) + CNN key —
   MIREX-class, best off-the-shelf. Targets: key ≥ 85%, chord (MajMin) ≥ 70%.
2. **librosa (preview + fallback):** rule-based key (Krumhansl/Temperley) +
   template/chroma chords — instant, weaker. Used for the sub-second preview and if
   madmom is unavailable. Floor targets: key ≥ 75%, chord ≥ 55%.
3. Everything degrades on jazz/classical/modal material. We promise "matches a
   human on familiar pop songs," not 100%.

**Usage: personal / non-commercial** (resolved) — this is what makes the madmom (NC)
and essentia (AGPL) engines usable at all.

## Changes from the previous draft (strikes)

1. **Strike "madmom … MIT"** → BSD code, **CC-BY-NC-SA (NonCommercial) models**, required.
2. **Strike "madmom default / essentia fallback"** → **librosa default**; madmom &
   essentia are opt-in tiers. "Primary by accuracy" ≠ "default-shipped by reliability."
3. **Strike "mirror tempo's `executor.ts`"** → it uses `sh -c` (injection on user
   file paths), buffers + truncates at 4096 bytes, no timeout/cancel. Use **array-form
   `Bun.spawn`** + AbortSignal + timeout (mirror `tempo/src/daemon.ts` instead).
4. **Strike "`active/personal-library` precedent"** → that path **does not exist**;
   use `finance/` or `free-claude-code/` for the uv precedent.
5. **Strike "Py3.10–3.12 / numpy<2"** → madmom pin is ≤Py3.9 / numpy<1.24 / scipy<1.13
   / Cython<3 / git main, isolated in an optional extra.
6. **Strike "chroma-based 7th/extension inference"** → snake oil (chroma can't separate
   maj from maj7). Extended = **refused at MVP** (triads only) with an honest disabled
   toggle; real extended deferred to Phase 4a (Chordino/NNLS or torch, when a checkpoint exists).
7. **Strike "`uv run --project` per call"** → resolve `.venv/bin/python` once, spawn directly.
8. **Strike implicit `import.meta.dir` for engine location** → breaks in compiled binary;
   resolve via `$CHORDTUI_ENGINE_DIR` → `~/.local/share/chordtui/engine` → sibling.
9. **Pin `@opentui/*` EXACT (no caret) + commit `bun.lock`** (0.1.x churn is the real risk).

## 2. Architecture

**Polyglot split:**
1. **Frontend** — TypeScript, Bun, OpenTUI (`@opentui/core` + `@opentui/react` `0.1.87`,
   React 19). Dual entry: no args → TUI; args → CLI. Binary name `chord`.
2. **Engine** — Python sidecar, `uv`-managed venv. One `analyze.py` per run; one cheap
   `engine-info` call for capability/version discovery.
3. **Interface** — a versioned JSON contract (§3) over `Bun.spawn` (§4). The contract
   is the only coupling; frontend and engine are independently testable against it.

**Tiered engines** (all behind the *same* contract, differentiated only by
`engineCapabilities` and confidence):

| Tier | License | Install | Selection | Accuracy |
|------|---------|---------|-----------|----------|
| **madmom** (v1 default) | code BSD / **models CC-BY-NC-SA** | must succeed on *your* machine (Phase-0 probe) | default for the final result; one-time NC notice | best off-the-shelf (~80%) |
| **librosa** (preview + fallback) | ISC (clean) | always | instant preview; sole engine if madmom probe fails | weakest |
| **essentia** (opt-in alt) | **AGPL-3.0** | fresh arm64 wheel | explicit `--engine essentia` + banner | rule-based, mid |

**Contract-as-interface (decided):** the JSON contract is the keystone Phase-0
deliverable. After it round-trips through a committed **mock sidecar**, engine and
frontend proceed **in parallel** (Phase 1 ∥ Phase 2). The engine designs to a stable
interface so a future **permissive torch ACR model** can replace madmom without
touching the frontend.

**Capability-based degradation (decided):** the frontend renders a sub-panel **iff**
the corresponding capability is in `engineCapabilities[]`. A nullable field that is
`null` means "engine could not compute" → the sub-feature is **removed, never faked**.
The UI never sniffs the engine name.

## 3. The JSON contract (keystone deliverable)

`engine/schema.json` (JSON Schema) and `src/core/types.ts` (TS) are co-authored and
kept in lockstep; the mock sidecar emits fixtures conforming to both.

```ts
// src/core/types.ts — the sole frontend↔engine coupling.
export type ContractVersion = "1.0.0";            // frontend rejects a mismatched major

export type EngineCapability =
  | "key" | "keyCandidates" | "chords"
  | "beats" | "downbeats" | "timeSignature"
  | "extendedChords";                              // refused at MVP (triads only)

export type ConfidenceKind = "posterior" | "correlation" | "heuristic";
export type EngineName = "librosa" | "madmom" | "essentia";

export interface EngineInfo {
  name: EngineName;
  version: string;
  license: string;                                // "ISC" | "CC-BY-NC-SA-4.0" | "AGPL-3.0"
  modelVersions: Record<string, string>;          // {} when rule-based (librosa)
  confidenceKind: ConfidenceKind;                 // posterior=madmom, correlation=librosa key, heuristic=essentia
}

export interface KeyResult { tonic: string; mode: "major" | "minor"; confidence: number; }
export interface KeyCandidate { tonic: string; mode: "major" | "minor"; confidence: number; }

/** GAP-FREE, contiguous over [0, durationSec]. Silence/unknown = explicit "N"
 *  segments, never gaps. label==="N" => root===null, quality==="N". */
export interface ChordSegment {
  start: number; end: number;                     // seconds; segment[i].end === segment[i+1].start
  label: string;                                  // "C", "Am", "N"
  root: string | null;                            // null only when label==="N"
  quality: "maj" | "min" | "N" | string;          // triads at MVP; string = future vocab
  confidence: number | null;                      // null = engine exposes no per-segment confidence
}

export interface Analysis {
  contractVersion: ContractVersion;
  file: string; durationSec: number;
  engine: EngineInfo;
  engineCapabilities: EngineCapability[];         // drives which panels render
  vocabulary: "triads";                           // "extended" refused at MVP
  key: KeyResult;
  // Nullable advanced fields: null = engine couldn't compute (panel removed);
  // a MISSING field = malformed output (engine.ts treats the run as an error).
  keyCandidates: KeyCandidate[] | null;           // top-3
  chords: ChordSegment[];                          // always present, gap-free
  beats: number[] | null;
  downbeats: number[] | null;
  timeSignature: string | null;
}
```

**Semantics:** (1) `T | null` (never `undefined`): `null` removes the sub-feature, a
*missing* required field is an error. (2) capability-gated rendering. (3) **enharmonic
spelling derived TS-side** in `music.ts` from `(key, root, quality)`. (4) **roman
numerals computed TS-side, in-key only** (out-of-key omitted, never invented).
(5) `confidenceKind` tells the UI how to interpret the number.

## 4. IPC protocol

- **Invocation:** array-form `Bun.spawn` (never `sh -c`). One run = one child.
- **stdout:** exactly **one** JSON document — a success `Analysis`, or
  `{ "error": { "kind", "detail", "hint" } }` where `kind ∈ bad_input | decode_failed
  | engine_unavailable | internal`.
- **stderr:** **NDJSON**, one type-discriminated object/line:
  `{type:"progress", stage, index, total}` (coarse **ordered stages**:
  decode→features→beat-track→chord-decode→key-detect→assemble — **not** a %) and
  `{type:"log", level, msg}`.
- **Exit codes:** 0 ok · 2 bad input · 3 engine-unavailable (no stdout → route to
  `doctor`) · 4 analysis/internal. Any nonzero ⇒ report the error object.
- **engine.ts** (mirror `tempo/src/daemon.ts`, NOT `executor.ts`): array-form spawn;
  AbortSignal → SIGTERM → SIGKILL grace; per-run wall-clock timeout; **incremental**
  line-framed stderr for progress; **buffer stdout fully** then parse+validate (no
  truncation). Validation/parse/contract-major mismatch ⇒ error, not partial success.

## 5. Repo structure

```
chordTUI/                       # incubation/ first; promote to active/ after Phase 3
├── LICENSE                     # MIT (Phase 0)
├── README.md                   # install, usage, accuracy caveats, NC/AGPL notices
├── package.json                # bun, ESM, @opentui/* 0.1.87 EXACT, react 19; bin: {"chord":"src/index.tsx"}
├── tsconfig.json               # from tempo: jsx react-jsx, jsxImportSource @opentui/react
├── bun.lock                    # committed; exact pins
├── docs/probe-matrix.md        # Phase-0 go/no-go results
├── src/
│   ├── index.tsx               # dual-mode router
│   ├── cli/commands.ts         # analyze <file> [--engine] [--json], setup, doctor, engine-info
│   ├── core/
│   │   ├── types.ts            # the contract (§3) — Phase 0
│   │   ├── engine.ts           # array-form spawn + AbortSignal + timeout + NDJSON stderr + validate
│   │   ├── engineResolve.ts    # engineDir + venv python path, resolved ONCE
│   │   ├── cache.ts            # ~/.cache/chordtui/results/<sha256>.json, per-engine, best-available
│   │   └── music.ts            # enharmonic spelling, roman numerals (in-key), color-by-quality (pure)
│   ├── hooks/useAnalysis.ts    # state machine; ONE AbortController per run
│   └── components/             # App, Header, KeyPanel, ChordTimeline(scrollbox), ProgressionPanel, FilePicker, StatusBar
├── engine/                     # Python sidecar (uv-managed)
│   ├── pyproject.toml          # core deps clean; optional extras [madmom],[essentia]
│   ├── uv.lock                 # committed; locks ONLY the clean core
│   ├── schema.json             # JSON Schema mirror of types.ts
│   ├── mock_sidecar.py         # Phase-0 deliverable
│   ├── analyze.py / engine_info.py
│   └── engines/{librosa,madmom,essentia}_engine.py
└── tests/
    ├── fixtures/{audio,ground_truth,contract}/   # MIDI-synth CC0 WAVs + labels + canonical JSON
    ├── ts/                     # bun test: music.ts pure + engine.ts via mock sidecar + createTestRenderer
    └── py/                     # pytest: engines + schema validation
```

**Dependency policy:** core (always installs, clean) = `librosa`, `numpy`, `scipy`,
`soundfile`. Optional extras `[madmom]` (NC notice) and `[essentia]` (AGPL banner)
hold their constraints, isolated from core. Committed `uv.lock` locks **only** the
clean core (default `uv sync` pulls zero NC/AGPL). `bun.lock` exact; v1 ships
macOS-arm64 (the `bun run` source path stays cross-platform).

## 6. Install & launch story

1. **`chord setup`** — extracts the embedded engine sources (compiled-binary distro),
   creates the uv venv, installs the **clean core** (librosa) by default; prints how
   to opt into madmom (NC) / essentia (AGPL).
2. **Engine dir resolution** (`engineResolve.ts`): `$CHORDTUI_ENGINE_DIR` →
   `~/.local/share/chordtui/engine` → sibling `engine/` (dev).
3. **Python path resolved ONCE** — reuse `.venv/bin/python`; **no per-call `uv run`**.
   `engine-info --json` is the cheap call for cache keys + capability discovery.
4. **Cache** at `~/.cache/chordtui/results/<sha256(audio)>.json`, per-engine; prefers
   best-available; drives the preview→upgrade flow.
5. **Distribution:** compiled binary (`bun build --compile`) with `analyze.py` embedded,
   extracted on setup. v1 = macOS-arm64. **Whether `--compile` works with OpenTUI
   native deps is UNVERIFIED — a Phase-0 probe.** `bun run` source path is the fallback.

**Run-state machine** (`useAnalysis.ts`): `idle → running.preview (librosa, instant)
→ done.preview (auto-upgrade if a better engine is enabled) → running.upgrade (madmom
20–60s; preview stays + "↑upgrading") → done.upgrade (swap) → cancelling → idle /
error (keep preview)`. **One AbortController per run** owns both sub-jobs.
Single-in-flight guard on **user** runs (`useKeyboard` fires on key-repeat). `fast` =
stop at preview; `accurate` = auto-chain. Child killed on quit/unmount.

## 7. Phased plan

Repeated pattern (stated once): every engine implements the same
`analyze.py --engine X --file F --json` + `engine-info` shape; every panel reads
`engineCapabilities[]`; every spawn uses the §4 array-form + AbortSignal + timeout.

**Phase 0 — Contract + gate (no app/engine logic until this passes).** Deliverables:
`LICENSE` (MIT) + repo placement (`incubation/chordTUI`) + registry stub;
`src/core/types.ts` + `engine/schema.json` (contract); `engine/mock_sidecar.py`
(sparse + full fixtures); `pyproject.toml` clean core + `uv.lock`; `docs/probe-matrix.md`
incl. the **`bun build --compile`-with-native-deps probe**. **The first action is the
madmom install+run probe** (create the pinned uv env, run a madmom chord/key processor
on a WAV — not a bare import) — because the ~80% target makes madmom the default, so its
viability gates the headline goal. **Gate:** ① **madmom installs and runs on this
machine** — ✅ **PASSED 2026-05-22** (Py3.9.6 + numpy 1.23.5; correctly read a synth
I–IV–V–I as C/F/G/C in C major; recipe in `engine/probe-matrix.md`/`docs/probe-matrix.md`);
② contract round-trips (mock
output validates against `types.ts`+`schema.json` and parses in `engine.ts`); ③ librosa
preview/fallback runs end-to-end; ④ license + repo decided.

**Phase 1 — Engine (librosa-first) ∥ Phase 2 — Frontend (mock-first)** — run in
parallel against the frozen contract.
- *Engine:* `engines/librosa_engine.py` (caps `["key","chords"]`), `engine_info.py`,
  then `madmom_engine.py` (opt-in; adds keyCandidates/beats/downbeats; **no mypy**),
  `essentia_engine.py` (opt-in); pytest + ruff.
- *Frontend:* scaffold from tempo (add the `bin` field tempo lacks); `engine.ts`,
  `engineResolve.ts`, `cache.ts`, `music.ts`; `useAnalysis` state machine; `App` +
  panels on OpenTUI `scrollbox`/`select`/`input` + resize hooks; CLI
  `chord analyze --json` end-to-end **against the mock**; `bun test` (music.ts pure +
  engine.ts mock scenarios: success/slow/hang/garbage/error/partial-killed +
  `createTestRenderer` sparse-vs-full).

**Phase 3 — Integration + accuracy gate + promotion.** Wire real engines; run the
accuracy gate (librosa blocking, madmom nightly, essentia smoke); `chord doctor` table
(INSTALLED / WORKING=ran-a-processor-on-a-WAV / LICENSE / DEFAULT); promote
`incubation/` → `active/`; update registry.

**Phase 4a — Real extended chords + polish.** Triads-only stays MVP; extended toggle
is **disabled** until backed by a real model (Chordino/NNLS or torch ACR; **deferred
if no permissive checkpoint**). Confidence display per `confidenceKind`; color-by-quality;
README caveats + NC/AGPL notices.

**Phase 4b — Playback & build matrix.** Playback + playhead sync to `ChordTimeline`,
mini-map, multi-platform builds (beyond macOS-arm64).

## 8. Reference files to mirror (corrected)

1. **Spawn precedent — `tempo/src/daemon.ts` (~L141):** array-form `Bun.spawn` + signal.
   **Do NOT mirror `tempo/src/core/executor.ts`** (`sh -c` + buffered + 4096 truncate + no cancel).
2. **Dual-mode entry — `tempo/src/index.tsx`:** no args → `createCliRenderer()` +
   `createRoot(renderer).render(<App/>)`; args → CLI switch.
3. **Layout idioms — `tempo/src/components/App.tsx`:** `<box>`/`<text>`, flexbox props,
   `useKeyboard`, `useRenderer`, modal pattern, per-component color const.
4. **Bun/TS config — `tempo/package.json` + `tsconfig.json`** (note: tempo has **no
   `bin`** — we add `bin: {"chord":"src/index.tsx"}`).
5. **uv precedent — `finance/` or `free-claude-code/`** (NOT the nonexistent `personal-library`).
6. **OpenTUI 0.1.87 components that exist:** `scrollbox` (`scrollLeft`, `viewportCulling`,
   `stickyStart`) for the timeline; `useTimeline`; `select`; `input`;
   `useTerminalDimensions`/`useOnResize`; `@opentui/core/testing` `createTestRenderer`.

## 9. Verification

- **Phase 0:** mock output validates against `types.ts`+`schema.json` and parses in
  `engine.ts`; the three gate conditions checked in `docs/probe-matrix.md`.
- **Phase 1:** `uv run python analyze.py --engine librosa --file <fixture.wav> --json`
  → valid contract JSON; bad path prints error JSON with exit 2/3/4; stderr emits NDJSON
  stages; `ruff` + `pytest` green.
- **Phase 2:** `bun test` green (music.ts pure; engine.ts mock scenarios incl.
  hang→SIGTERM→SIGKILL; component sparse-vs-full); `bun run typecheck` clean; assert
  `engine.ts` has no `sh -c` and wires an AbortSignal.
- **Phase 3:** live `chord analyze --json` + TUI populate per capability; re-run hits
  cache; `q` mid-upgrade kills the child (no orphaned python); `chord doctor` prints
  the per-engine table.
- **Accuracy gate (priority-#1 check):** fixtures = MIDI-synthesized **CC0** WAVs
  (fluidsynth + CC0 soundfont, committed; real annotated pop audio is NOT
  redistributable). Metric = MIREX **WCSR (MajMin, root-aware)** + weighted key.
  Thresholds: librosa **blocking** key≥75%/chord≥55%; madmom **nightly** key≥85%/chord≥70%;
  essentia smoke-only. CI: `bun test` + typecheck + `ruff` + `pytest` (clean core).
- **Manual:** `chord setup` → `chord analyze <familiar-pop-song.mp3>` → key + main
  progression match a human; `chord` (no args) → TUI; extended toggle visibly disabled.

## 10. Risks (top)

1. **madmom won't install on a clean 2026 machine** (<70% even pinned) — biggest stall
   risk. Mitigated by librosa default + madmom opt-in, never in the blocking path.
2. **NC/AGPL exposure on a public repo** — gated on Open decision (a); clean-core lock,
   opt-in extras, banners. Critical-if-commercial, low-if-personal.
3. **`bun build --compile` + OpenTUI native deps unverified** — Phase-0 probe; fall back
   to the `bun run` source path.
4. **Accuracy underdelivery** — librosa floor is honest-but-weak; set expectations;
   judge against the §9 gates, not 100%.
5. **Contract drift TS↔Python** — contract-first, round-trip gate, `contractVersion`.
6. **Scope creep** (preview→upgrade, playback, extended) — fenced by phases; extended
   refused at MVP; playback in 4b.

**Single de-risking action before any code:** run the real install probe (pinned uv env
+ run a madmom processor on a WAV, not a bare import) + confirm the librosa floor passes
the accuracy gate + lock the JSON contract (round-trip against the mock sidecar). These
three outcomes decide whether madmom is in scope and whether the project ships on librosa alone.
