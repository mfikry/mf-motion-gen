# MF Motion Gen 2.0 — Roadmap
**Status:** Initial gated roadmap. No phase is skipped without evidence.

## Phase 0 — Project foundation
- [ ] Create clean V2 repository and folder.
- [ ] Add PRD, technical design, roadmap, and agent instructions.
- [ ] Add README, `.gitignore`, and decision templates.
- **Exit:** clean repository independent of V1.

## Phase 1 — Product and benchmark definition
- [ ] Collect exact reference video(s).
- [ ] Define visual quality rubric and approval process.
- [ ] Confirm formats, resolution, FPS, duration, and alpha needs.
- [ ] Confirm ZIP import, folder import, or both.
- **Exit:** product owner approves scope and acceptance criteria.

## Phase 2 — Research and architecture
- [ ] Compare Electron and Tauri.
- [ ] Evaluate Chromium capture and isolation approaches.
- [ ] Test exact-time control for CSS, SVG, Canvas, GSAP, and required WebGL.
- [ ] Evaluate encoder options and licensing.
- [ ] Define manifest and security model; record ADRs.
- **Exit:** architecture backed by prototype evidence.

## Phase 3 — Technical proof of concept
- [ ] Import a sample package.
- [ ] Preview and seek to arbitrary timestamps.
- [ ] Capture frames and render a full video.
- [ ] Compare preview and export at identical timestamps.
- [ ] Repeat render for determinism.
- [ ] Test missing assets, errors, cancellation, and prohibited access.
- **Exit:** fidelity, parity, determinism, and isolation pass.

## Phase 4 — Application foundation
- [ ] Build desktop shell and project lifecycle.
- [ ] Implement import validation and errors.
- [ ] Implement isolated preview runtime and timeline.
- [ ] Implement render queue, progress, cancellation, and logs.
- **Exit:** end-to-end workflow works on approved samples.

## Phase 5 — Export and quality hardening
- [ ] Add approved codecs/formats.
- [ ] Validate dimensions, FPS, duration, and alpha if required.
- [ ] Add visual regression benchmark suite.
- [ ] Test long renders, resource limits, and Windows packaging.
- **Exit:** release candidate passes functional, visual, performance, and security checks.

## Phase 6 — Release
- [ ] Product owner reviews benchmark renders.
- [ ] Document supported project contract and limitations.
- [ ] Tag release and archive build artifacts.
- **Exit:** explicit product-owner approval.

## Working rule
When a gate fails, investigate the root cause and update the design before expanding implementation.
