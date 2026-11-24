# MF Motion Gen 2.0

**Status:** Phase 4 — Application Architecture & Foundation (Phase 3 Technology Validation complete & accepted)<br>
**Target:** Windows desktop<br>
**Product direction:** Import HTML motion projects → preview/seek → render → export.

MF Motion Gen is intended to make high-quality motion graphics from HTML-based projects authored externally (initially Gemini AI Studio). It is not initially a built-in text-to-motion generator or a full visual motion-design editor.

## Current architecture recommendation (POC-validated baseline)

- Desktop shell: Electron
- UI: React + TypeScript
- HTML-to-video engine candidate: HyperFrames (`@hyperframes/core`, `@hyperframes/engine`, `@hyperframes/producer`) — accepted candidate for implementation
- Animation timeline: GSAP paused timelines / seek-by-frame contract
- Encoding: FFmpeg through the rendering pipeline

Phase 3 technical proof-of-concept (HyperFrames spike Round 1 and Round 2) has successfully completed and been accepted by the Product Owner. Final application architecture, IPC design, and production security isolation will be determined through formal ADRs in Phase 4.

## Documents

- `PRD.md` — product requirements and target workflow.
- `TECHNICAL_DESIGN.md` — provisional system architecture and runtime contract.
- `TECHNOLOGY_EVALUATION.md` — evidence-based comparison of candidate technologies.
- `ROADMAP.md` — gated plan from research to release.
- `AGENTS.md` — rules for Antigravity and implementation work.
- `.gitignore` — generated/local files excluded from Git.

## Import direction

The input experience should remain simple:
- Paste complete HTML source.
- Drag/drop or choose one or multiple `.html` files.
- Support a project folder or ZIP where HTML references local images, fonts, or other assets.
- Validate whether the source follows the supported deterministic animation contract before enabling final render.

A separate Canvas JavaScript mode using `renderFrame(ctx, time, frame, totalFrames, config)` is a compatibility candidate, not the primary project format until the prototype validates it.

## Important rules

- V2 is independent of V1. Do not copy V1 code or assume its architecture.
- Visual quality is a release gate against the supplied reference videos.
- Preview/export parity and deterministic frame seeking are mandatory.
- Imported HTML/JS is untrusted code and must be isolated.
- Do not begin broad application implementation before the technical spike passes.
