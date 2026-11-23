# MF Motion Gen 2.0

**Status:** Foundation + technology evaluation (Draft 0.2)  
**Target:** Windows desktop  
**Product direction:** Import HTML motion projects → preview/seek → render → export.

MF Motion Gen is intended to make high-quality motion graphics from HTML-based projects authored externally (initially Gemini AI Studio). It is not initially a built-in text-to-motion generator or a full visual motion-design editor.

## Current architecture recommendation (provisional)

- Desktop shell: Electron
- UI: React + TypeScript
- HTML-to-video engine candidate: HyperFrames (`@hyperframes/core`, `@hyperframes/engine`, `@hyperframes/producer`)
- Animation timeline: GSAP paused timelines / seek-by-frame contract
- Encoding: FFmpeg through the rendering pipeline

**Nothing is frozen yet.** HyperFrames is the strongest fit found in research, but its Frame Adapter API is currently experimental and must pass our prototype and security gates before production approval.

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
