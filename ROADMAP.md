# MF Motion Gen 2.0 — Roadmap

**Status:** Draft 0.2. Progress is gated by evidence, not calendar dates.

## Phase 0 — Project foundation
- [x] Create clean V2 repository and local folder.
- [x] Add initial project documentation and agent rules.
- [x] Separate V2 from V1.
- **Exit:** foundation exists and V1 remains untouched.

## Phase 1 — Product and benchmark definition
- [x] Capture the intended HTML import UX reference.
- [x] Receive seven visual benchmark videos.
- [x] Inspect reference durations, resolution, and frame rates.
- [ ] Confirm the exact benchmark quality rubric with the product owner.
- **Exit:** benchmark inventory and import direction are confirmed.

## Phase 2 — Technology research
- [x] Compare HyperFrames, Remotion, raw browser automation, and alternate desktop shell options.
- [x] Identify deterministic-seeking and licensing risks.
- [x] Produce a provisional stack recommendation.
- [ ] Pin the exact HyperFrames/browser package versions after the POC.
- **Exit:** technology candidate accepted for a POC (not yet production approval).

## Phase 3 — Technical proof of concept
- [ ] Define MF Motion HTML contract and Gemini authoring prompt.
- [ ] Import standalone HTML and local asset project.
- [ ] Test GSAP seek-by-frame, including backward/random seeking.
- [ ] Test Canvas `renderFrame` adapter viability.
- [ ] Compare visible preview and exported frame output.
- [ ] Repeat render for determinism.
- [ ] Test 1080p30, 4K30, and 4K60.
- [ ] Test transparent MOV ProRes 4444 output.
- [ ] Test package validation, network restrictions, cancellation, crash recovery, and limits.
- **Exit:** visual, parity, determinism, safety, export, and performance gates pass.

## Phase 4 — Application foundation
- [ ] Build Electron + React + TypeScript shell.
- [ ] Build paste/import/batch-import UX.
- [ ] Implement source validator and asset packaging.
- [ ] Integrate isolated preview runtime.
- [ ] Implement timeline controls and project persistence.
- **Exit:** end-to-end preview works on benchmark compositions.

## Phase 5 — Render/export workflow
- [ ] Integrate isolated render worker.
- [ ] Implement render queue, progress, cancellation, and logs.
- [ ] Implement MP4 and alpha MOV export.
- [ ] Validate WebM alpha if still in scope.
- [ ] Add regression benchmark suite and performance controls.
- **Exit:** render/export parity and QA pass.

## Phase 6 — Release readiness
- [ ] Test on clean Windows installation.
- [ ] Audit dependencies and licenses.
- [ ] Complete security and failure-mode tests.
- [ ] Product owner reviews all benchmark renders.
- [ ] Document the supported HTML contract and compatibility matrix.
- **Exit:** explicit product-owner approval.

## Working rule

Do not skip a gate because a feature is easy to code. When a gate fails, find the root cause and adjust the design before expanding implementation.
