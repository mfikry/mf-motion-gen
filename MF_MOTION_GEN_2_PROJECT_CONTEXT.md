# MF Motion Gen 2.0 — Project Context & Handoff

> **Purpose:** This file is the working memory / handoff brief for future ChatGPT sessions and project contributors. Read it before proposing work, reviewing Antigravity output, or changing project direction.
>
> **Snapshot date:** 24 November 2026  
> **Last reviewed against:** `MF Motion Gen.zip` uploaded by the Product Owner on 24 November 2026, plus decisions and approvals recorded in the project conversation through this date.  
> **Document status:** Working context; update whenever the Product Owner approves a decision or a newer repository snapshot supersedes this one.

---

## 0. How to use this document

1. Treat the latest user-provided project archive and explicit Product Owner decisions as the primary sources of truth.
2. Treat this file as a navigation aid and condensed project memory, not as a replacement for `PRD.md`, `AGENTS.md`, ADRs, test reports, or actual source code.
3. Distinguish **accepted POC evidence**, **proposed architecture**, **pending validation**, and **Product Owner-approved decisions**. A POC pass is not the same as production readiness.
4. If a necessary fact is missing or conflicting, ask the Product Owner for the specific artifact or decision needed. Do not silently invent or infer approval.
5. When a newer ZIP/report arrives, compare it with this document and update the snapshot date, Git checkpoint, Phase 4 status, open issues, and decision log.
6. Do not claim to have changed the user's local Windows repository. ChatGPT can review provided archives/reports and prepare tasks; Antigravity performs local repository work.

### Status vocabulary

- **Accepted by PO:** explicitly approved by the Product Owner.
- **Accepted POC baseline:** demonstrated and accepted as evidence, but not automatically production-approved.
- **Proposed:** a recommendation in a draft; not yet approved.
- **Pending validation:** requires a reproducible experiment or test.
- **Open:** unresolved requirement, decision, or question.
- **Rejected:** explicitly declined by PM/PO.

---

## 1. Project identity

| Field | Current information |
|---|---|
| Product | **MF Motion Gen** |
| Version | **2.0** |
| Platform target | Windows desktop (initial target) |
| Product type | HTML motion-graphics import, validation, preview, and render/export studio |
| Local project folder | `F:\PROJECT\MF Motion Gen` |
| Git remote | `https://github.com/mfikry/mf-motion-gen.git` |
| Main branch | `main` |
| Latest known local commit | `7ceb86605e9611a03e8a91fe1b84edd011197958` |
| Commit subject | `feat(poc): close Phase 3 HyperFrames validation` |
| Parent commit | `d8b4aab55d87e0bb9a2bf3c6700759416c4669bf` |
| Latest reported remote relation | Local `main` was **ahead 1** of `origin/main`; no push was performed |
| Current application implementation | **Not started** in the snapshot reviewed; Phase 4 remains architecture/discovery work |

**Important Git caveat:** The uploaded ZIP does not include `.git`, so the commit and branch state above come from the most recent Antigravity Git verification report in the conversation, not independent inspection of the ZIP. Verify `git status` and `git log` again before any later commit/push decision.

---

## 2. Roles and working agreement

| Participant | Role | Responsibilities |
|---|---|---|
| User | Product Owner (PO) | Owns product direction, scope, visual acceptance, and final decisions |
| ChatGPT | Project Manager + Technical Architect + reviewer | Maintains project direction, reviews technical work, writes task briefs, checks evidence and risks, recommends decisions |
| Antigravity | Implementer + technical researcher | Works in the local Windows repository, researches, edits files, implements only after approval, reports exact results |
| Claude | Separate V1 work | Continues V1 independently; V1 is not a V2 source baseline |

### Collaboration workflow

1. ChatGPT prepares a bounded task brief in Indonesian (technical identifiers remain in English).
2. The Product Owner passes the task to Antigravity.
3. Antigravity performs the work locally and returns a report, diffs, logs, or files.
4. ChatGPT reviews the actual evidence and classifies findings as pass, caveat, or blocker.
5. The Product Owner approves product-level decisions. Antigravity must not treat a draft recommendation as PO approval.

### Working preferences / guardrails

- Be direct, practical, and specific; use natural Indonesian in conversation.
- Do not ask the Product Owner to repeat information already available in the PRD, current archive, or conversation.
- If a critical fact is missing, ask one targeted question rather than guessing.
- Do not promise background work or future delivery. Complete the work in the current turn when possible.
- Do not claim code, tests, commits, or pushes succeeded without Antigravity evidence.
- For non-trivial implementation tasks, require: requirement understanding, proposed approach, affected files/modules, risks, and test/acceptance plan.

---

## 3. Product vision and positioning

MF Motion Gen 2.0 is intended to make high-quality motion graphics from HTML-based projects authored externally, initially in **Gemini AI Studio**.

The first product is an **import → validate → preview/seek → render → export** desktop studio.

It is **not initially**:
- a built-in prompt-to-motion generator;
- a direct Gemini API authoring product;
- a full keyframe/vector/motion-design editor;
- a cloud rendering/collaboration platform;
- an unrestricted browser for arbitrary websites or arbitrary HTML/JavaScript.

### Main user workflow

1. Create the motion graphic externally (initially Gemini AI Studio).
2. Paste complete HTML, import one HTML file, batch-import multiple HTML files, or import a project folder/ZIP containing linked assets.
3. Validate the composition and asset references; display actionable errors and warnings.
4. Preview, play/pause, scrub, and seek to arbitrary timestamps/frames.
5. Set duration, resolution, frame rate, and output format.
6. Render deterministically, monitor progress, cancel safely, and inspect failure logs.
7. Save/reopen project state and re-import updated HTML when the external source changes.

### Product principles (from `PRD.md` and `AGENTS.md`)

- Visual quality is a release gate, not a cosmetic extra.
- Preview and export must match at equivalent timestamps within explicitly defined and reproducible tolerances.
- Final rendering must be frame-driven and seekable by absolute frame/time.
- Imported projects must be portable; required assets should be local and packaged.
- Imported HTML/JS/CSS/SVG/media/archives are untrusted and must not receive privileged desktop access.
- V2 is a clean project independent of V1.
- A generic HTML file may be previewable but is not automatically render-ready.
- Unsupported animation behavior must be reported honestly; no arbitrary compatibility claims.

---

## 4. PRD scope and requirements

**Current PRD:** `PRD.md`, Draft 0.2, Windows desktop.

### Must-have initial release scope

- Paste complete HTML source, including inline CSS/JS.
- Import a single `.html` file.
- Batch import multiple `.html` files.
- Import project folder or ZIP with local assets.
- Detect/display project name/title, composition dimensions, duration, FPS metadata when present, and validation status.
- Source/package validation with actionable diagnostics.
- Preview, play/pause, scrub, and arbitrary-time seek.
- Output resolution, FPS, duration, and format settings.
- Frame-by-frame rendering.
- Preview/export parity checks.
- Render progress, cancellation, failure details, and logs.
- Project save/reopen.
- Safe execution isolation for imported content.

### Explicitly out of scope unless PO approves later

- Built-in AI prompt-to-motion or direct Gemini API integration.
- Full keyframe/vector editor.
- Automatic beautification of weak source HTML.
- Cloud rendering/collaboration.
- Audio editing/mixing as a user-facing first-release feature.
- Unrestricted arbitrary website/HTML/JavaScript support.

**Scope nuance:** Technical evaluation of HyperFrames Producer audio mixing is still valid, but does not by itself add audio editing/mixing to the user-facing first-release scope. Embedded audio support, passthrough, or sync requirements need a separate PO decision if the product scope is to change.

### HTML contract direction

The first supported HTML profile should be narrow and deterministic:
- composition root with unique ID, width, and height;
- finite, explicit duration and target FPS;
- animation controllable by absolute frame/time;
- paused GSAP timeline(s) registered for seek;
- local fonts/images/SVG/scripts/other required assets;
- no runtime network dependency;
- readiness signal only after fonts and visual assets are loaded.

Do not silently convert the Canvas mode into the same contract as DOM/HTML. A separate candidate signature exists:

```js
function renderFrame(ctx, time, frame, totalFrames, config) {
  // Draw one frame for the requested time.
}
```

Canvas `renderFrame` is a separate adapter/mode to investigate; its inclusion in first release remains open.

---

## 5. Reference benchmark inventory

The PRD records seven user-provided visual references:

| Reference | Duration | Resolution | Frame rate |
|---|---:|---:|---:|
| World clocks | 10 s | 832×464 | ~59.7 fps average |
| Progress bar | 10 s | 832×464 | ~59.7 fps average |
| Countdown | 10 s | 3840×2160 | 30 fps |
| Wi-Fi icon (green-screen source) | 8 s | 3840×2160 | 60 fps |
| Breaking news | 10 s | 1024×576 | 30 fps |
| System breach / warning | 10 s | 3840×2160 | 60 fps |
| Low battery | 10 s | 3840×2160 | 30 fps |

These test typography, precise shapes, counters/timers, progress behavior, glow, glitch, visual hierarchy, pacing, and output configurations. Five of the seven are 4K references and establish a high-resolution quality target, not a guaranteed performance promise.

### Output targets to validate

- MP4 / H.264 for standard distribution.
- MOV / ProRes 4444 for transparent-video workflows.
- WebM / VP9 alpha as a secondary candidate; first-release requirement is still open.
- Baseline output: 1920×1080 at 30 fps.
- High-end tests: 3840×2160 at 30 fps and 60 fps.

### Separate quality gates

1. **Source-design quality:** the HTML design itself meets the reference standard for composition, typography, contrast, transitions, pacing, and polish.
2. **Render fidelity:** the engine reproduces the approved source without missing assets, timing drift, frame glitches, visual degradation, or export artifacts.

A renderer can preserve or degrade source design; it cannot automatically turn weak art direction into professional motion graphics. Judge these gates separately.

---

## 6. Phase 3 — HyperFrames technical validation (closed)

### Overall status

**Phase 3 is closed and accepted by the Product Owner.** Round 1 and Round 2 POC results were accepted; the PO explicitly said the Round 2 Breaking News result looked good and was satisfactory.

This acceptance means HyperFrames is a **POC-validated implementation candidate**, not that production security, clean-machine packaging, or final application architecture are already proven.

### POC stack/evidence in the archive

- HyperFrames packages resolved in the POC lockfile: `hyperframes`, `@hyperframes/core`, `@hyperframes/engine`, `@hyperframes/producer` **0.9.84**.
- GSAP resolved in the lockfile/runtime: **3.15.1**. The POC `package.json` uses caret ranges, while the lockfile resolves exact versions; for the application, use exact pins only after ADR approval.
- HyperFrames POC required Node.js 22+; the spike included a portable Node 22.23.5 binary.
- The tested browser artifact used `chrome-headless-shell` **158.0.8127.36**.
- POC also used FFmpeg; the README records Gyan build 7.0.2 for its original run. Exact production FFmpeg build is not approved.

### Round 1 — NEXUS / Gemini AI Studio source

- 8 seconds, 1080p30, 240 frames.
- HyperFrames v0.9.84 rendered the composition successfully.
- Audit discovered that `data-duration` on HyperFrames `.clip` elements represents element lifetime, not the duration of a GSAP intro tween. Some persistent design elements were being unmounted too early.
- A corrected working copy was generated while preserving the original source HTML.
- Representative-frame renderer-to-ProRes parity: mean SSIM **0.9879**, PSNR **36.75 dB** (7 representative samples; range SSIM 0.9858–0.9949).
- ProRes-to-H.264 mean SSIM **0.9126**, PSNR **38.18 dB**.
- Preview-to-final MP4 end-to-end mean SSIM **0.9044**, PSNR **34.06 dB**.
- Backward/repeated seek test for the relevant POC frames was reported bit-exact (SSIM 1.000000).
- 1080p30, 4K30, and 4K60 render tests were completed.
- ProRes 4444 Alpha output was verified. ProRes 4444 is a high-quality mezzanine format, not uncompressed raw; alpha was validated mathematically, while RGB is visually lossless rather than mathematically lossless.

### Round 2 — Breaking News reference

- Reference video was supplied by the Product Owner; it is not a generated AI Studio output.
- Reference metadata: 1024×576 at 30 fps, approximately 10 seconds / 298 frames.
- HTML source: 1920×1080, 30 fps, 10 seconds / exactly 300 frames.
- Rendered output: H.264 MP4 (5.47 MB) and ProRes 4444 MOV (~507.89 MB), each 300 frames.
- HyperFrames v0.9.84; `chrome-headless-shell` 158.0.8127.36; source preserved; external network requests 0 and console errors 0.
- Round 2 contained nine representative seeking samples: six were bit-exact (SSIM ≥0.99999 to 1.0); three ticker frames showed micro deviations of approximately SSIM 0.9997–0.9998 due to sub-pixel text positioning. No visible layout shift/glitch was reported.
- Renderer-to-ProRes mean SSIM **0.9319**, PSNR **25.19 dB**, with **94.57%** of pixels within Δ≤5. Difference was localized mainly to a one-pixel Skia rasterization shift around a 3.5px skewed CSS border.
- ProRes-to-H.264 mean SSIM **0.9789**, PSNR **41.36 dB**, with **98.35%** pixels within Δ≤5.
- MP4-vs-reference SSIM **0.5830** is not a useful universal render-fidelity metric because native resolutions differ (1920×1080 vs 1024×576) and the reference starts with a fade from black not present in the HTML source. Motion choreography was judged visually close; the PO watched the output and accepted it as good/satisfactory.

### POC security and production caveats

- Basic Chromium/headless isolation checks showed untrusted page context without Node/`require` access; CSP/network tests demonstrated offline blocking in the tested setup.
- Headless Chromium popup behavior was not fully blocked in one test; explicit popup denial is still required in the Electron application.
- POC is not proof of production Electron security.
- Electron `contextIsolation`, preload surface, `WebContentsView`/iframe boundary, Electron network policy, Windows process-tree termination, and packaged app hardening remain untested.
- Clean Windows installer/portable packaging and production FFmpeg/Chromium distribution are not proven.
- Do not repeat POC Round 1 or Round 2 without a concrete regression or new validation question; both were accepted.

---

## 7. Git checkpoint after Phase 3

The last verified local commit is:

```text
7ceb86605e9611a03e8a91fe1b84edd011197958
feat(poc): close Phase 3 HyperFrames validation
parent: d8b4aab55d87e0bb9a2bf3c6700759416c4669bf
```

The commit contains exactly **58 files** and closes the Phase 3 POC/documentation checkpoint. It was not pushed. The last reported state was `main...origin/main [ahead 1]`.

Eight Phase 3 diagnostic/scratch scripts were intentionally left untracked and must not be deleted or staged unless separately approved:

- `poc/hyperframes-spike/scripts/analyze_diff_bbox.mjs`
- `poc/hyperframes-spike/scripts/calibrate_preview.mjs`
- `poc/hyperframes-spike/scripts/find_brightest.mjs`
- `poc/hyperframes-spike/scripts/find_red_box.mjs`
- `poc/hyperframes-spike/scripts/inspect_patch.mjs`
- `poc/hyperframes-spike/scripts/sample_diff.mjs`
- `poc/hyperframes-spike/scripts/test_staging_verifier.ps1`
- `poc/hyperframes-spike/scripts/verify_gsap.mjs`

**Do not push automatically.** The latest local commit being one ahead of origin is intentional and was the approved state at the last checkpoint.

---

## 8. Phase 4 — current work and draft status

### Phase 4 objective

Complete architecture/design decisions before broad application implementation. The phase includes formal ADRs, application architecture blueprint, security architecture, UI/UX blueprint, and any focused validation spikes required to resolve critical uncertainty.

The current workstream is **Task 4.1 — Technology ADR Research & Architecture Discovery**. Antigravity has revised the four draft documents in `docs/phase4/`; the current uploaded ZIP contains the latest snapshot reviewed on 24 November 2026.

### Four Phase 4 draft files

1. `docs/phase4/PHASE4_TECHNOLOGY_ADR_DRAFT.md`
2. `docs/phase4/PHASE4_ARCHITECTURE_BLUEPRINT_DRAFT.md`
3. `docs/phase4/PHASE4_SECURITY_ARCHITECTURE_DRAFT.md`
4. `docs/phase4/PHASE4_UI_UX_BLUEPRINT_DRAFT.md`

### Current ADR status (as proposed in the latest ZIP; not PO-approved)

| ADR | Domain | Current proposal | Current status |
|---|---|---|---|
| ADR-001 | Desktop framework/lifecycle | Electron with active stable/support-version cadence; Electron 45.4.1 is the draft starting point | Proposed; PO approval pending; re-check current stable/support window before implementation |
| ADR-002 | Runtime/worker | Node runtime bundled with Electron; `utilityProcess` only as trusted orchestrator | Proposed; PO approval pending |
| ADR-003 | Render engine | HyperFrames 0.9.84 behind `MfMotionRenderer` abstraction | POC baseline accepted; production ADR still proposed/pending |
| ADR-004 | HTML/GSAP contract | Gemini-to-HyperFrames compatibility adapter, full `window.__hf` contract | Proposed; needs adapter conformance tests |
| ADR-005 | Encoding/distribution | Evaluate HyperFrames Producer for MP4/audio; custom FFmpeg pipeline for ProRes 4444/custom controls; Gyan.dev/BtbN builds considered | Proposed; license/legal review and exact build audit pending |
| ADR-006 | Browser architecture | Option A hybrid: Electron GUI preview + pinned `chrome-headless-shell` render; Option B unified browser as validation experiment | Pending Spike Test 4.1-A |

### Important Phase 4 draft findings

**What has improved in the latest ZIP:**
- ADR-001 now uses Electron stable/supported-release terminology rather than incorrectly calling Electron 46/47 LTS.
- ADR-004 now documents `window.__hf.duration`, `window.__hf.seek(t)`, optional media declaration, timeline discovery, ambiguous timeline warning, and the risks of GSAP `suppressEvents`.
- ADR-005 now recognizes that HyperFrames Producer supports MP4 H.264, WebM VP9 alpha, and audio mixing; it proposes comparing Producer and custom FFmpeg paths.
- ADR-005 no longer treats separate-process invocation as an automatic GPL safe harbor and calls for legal review/source/license artifacts.
- ADR-006 no longer assumes Electron Chromium can replace `chrome-headless-shell`; hybrid Option A is proposed as safe baseline and unified Option B requires Spike 4.1-A.
- Architecture Blueprint now distinguishes iframe sandboxing from OS process isolation and leaves iframe vs `WebContentsView` for a security spike.
- Architecture Blueprint now recognizes `utilityProcess` as trusted Node orchestrator only and proposes a six-layer watchdog/process-tree management design.
- Architecture Blueprint now separates determinism, renderer parity, alpha integrity, compression impact, and end-to-end visual acceptance metrics.

**Known remaining inconsistencies/blockers in the latest ZIP:**

1. **Security Architecture draft appears stale relative to the latest PM correction request.** It still proposes iframe as the untrusted preview container without clearly making process isolation the preferred validation target; its network policy explicitly allows arbitrary `file:` URLs; it contains old termination examples such as `process.kill('SIGKILL')` and `utilityProcess.kill('SIGKILL')`; its watchdog is still the older 20s/30s model; and the ZIP extraction section does not yet cover the full Windows/ZIP-bomb/symlink threat set. Do not implement from this file until synchronized with the corrected Architecture Blueprint and PM review.
2. **UI/UX Blueprint draft also appears stale.** It still hardcodes frame stepping to `1/30`; labels CRF 14 as “Visual Lossless” and shows CRF as a general export control despite ProRes needing separate quality settings; describes 100% preview as “Pixel-Exact”; contains an old `process.kill` flow; and still needs a consistent panel/status-strip definition, batch import and linked-asset UX, explicit frame indexing/end-frame semantics, and a clear separation between real-time playback and frame-accurate seeking.
3. **ADR-004 adapter code and prose are not fully aligned.** The prose lists optional `window.__hf.media`, but the sample bridge code does not yet expose a media declaration. Readiness is described, but the example only hooks `DOMContentLoaded`; late timeline registration/readiness and supported registration hooks still need a concrete, testable contract. `suppressEvents` fallback behavior remains a proposal, not a proven universal fix.
4. **Architecture Blueprint quality targets need further reconciliation.** The latest draft includes a Preview-vs-Raw target SSIM ≥0.98 based primarily on Round 1 evidence, while Round 2 renderer-to-ProRes measured SSIM 0.9319 under a different comparison setup. Do not make one universal SSIM threshold or copy targets across different benchmarks/pixel formats. Define exact pairings, color space, resolution, sample frames, aggregation, alpha-vs-RGB handling, and visual inspection criteria first.
5. **Watchdog design remains proposed.** Thresholds such as 20s per-frame, 10s CDP, 30s heartbeat, and process-tree kill behavior require validation under real Windows Electron/browser/FFmpeg processes. A Node V8 heap cap is not a total process-tree RAM limit.
6. **Browser and package compatibility remain open.** POC HyperFrames uses a pinned `chrome-headless-shell` (158.0.8127.36); Electron 45 draft carries Chromium 156. Do not claim version identity or preview/export parity from the hybrid architecture without testing.
7. **FFmpeg legal position is not a final legal determination.** Build source, version, flags, codecs, exact source offer/notices, and legal review need to be resolved before commercial distribution.

### Phase 4 status

**Task 4.1 is not closed.** The four documents remain drafts. The latest ZIP proves the files exist, but not that all last requested corrections were completed or approved. In particular, Security Architecture and UI/UX need synchronization with the newest PM corrections.

**No Phase 4 application implementation is approved yet.** Do not create the application shell, add dependencies, or begin broad implementation until PM review and PO decisions are explicit. A narrowly scoped validation spike may be approved separately, with its own task and acceptance criteria.

---

## 9. Architecture direction — proposed, not all final

### Candidate high-level stack

- **Desktop shell:** Electron.
- **UI:** React + TypeScript.
- **Renderer abstraction:** internal `MfMotionRenderer` / `IMotionRenderer` interface.
- **Render engine candidate:** HyperFrames pinned behind an adapter; POC baseline 0.9.84.
- **Animation contract:** paused GSAP timeline(s), absolute seek, MF Motion compatibility adapter.
- **Capture browser:** pinned `chrome-headless-shell` for the hybrid Option A baseline; Electron Chromium replacement is not assumed.
- **Encoding:** evaluate HyperFrames Producer for MP4 H.264 / WebM VP9 alpha / audio mixing; custom FFmpeg remains candidate for ProRes 4444 Alpha and specialized controls.
- **Asset handling:** local project assets via constrained asset resolver/protocol; no unrestricted file or network access.

### Proposed execution boundaries

1. **Studio UI renderer:** React UI, timeline, import/validation panels, export settings.
2. **Electron main/host process:** lifecycle, validated IPC gatekeeper, dialogs, project orchestration, asset registration, job coordination.
3. **Untrusted preview boundary:** dedicated isolated WebContents is a leading candidate; sandboxed iframe remains a comparison candidate, not an assumed OS process boundary.
4. **Trusted render orchestrator:** `utilityProcess`/trusted worker may call browser and encoder processes but must never execute imported HTML/JS inside its Node context.
5. **Untrusted browser rendering process:** executes composition only with no Node, no preload, no privileged IPC, restricted file/network access, and Chromium OS sandboxing.
6. **Encoder process:** receives approved frame/audio streams and writes output; exact Producer/FFmpeg split awaits validation and license review.

### Security baseline principles

- Imported HTML, JavaScript, CSS, SVG, images, media, and ZIP archives are untrusted.
- Never expose Node, filesystem, shell, process, credentials, environment secrets, or privileged IPC to imported content.
- No privileged preload in preview/imported HTML.
- Default-deny network and navigation; deny popups, downloads, permissions, and external protocols unless specifically approved.
- Do not permit arbitrary `file://` reads from imported content; resolve local assets through a constrained allowlist/protocol.
- Validate archive paths, symlinks, duplicate/case-insensitive paths, drive/UNC paths, file counts, expanded size, and decompression ratios.
- Enforce project/resource limits, browser/CDP deadlines, frame progress, worker heartbeat, encoder health/backpressure, cancellation, and process-tree cleanup.
- A browser sandbox alone is not a complete security strategy; verify the actual Electron and Windows behavior.

---

## 10. Open technical questions and PO decisions

### Open technical questions

1. Can the tested HyperFrames engine be made to use Electron's browser binary, or should production keep a pinned `chrome-headless-shell` separate from Electron Chromium?
2. Which preview container is secure and practical: `WebContentsView`/dedicated WebContents or sandboxed iframe? What are the process isolation and communication costs?
3. What is the real compatibility contract for Gemini HTML, `window.__timelines.main`, multiple GSAP timelines, timeline registration timing, callbacks, media, `.clip` lifecycle, and `window.__hf`?
4. Can HyperFrames Producer meet required MP4 quality/progress/cancellation and any media needs? Which capabilities require custom FFmpeg?
5. Which exact Windows FFmpeg build is needed for H.264 and ProRes 4444 Alpha, and what distribution obligations apply?
6. What deterministic parity tolerances are valid per benchmark and per stage of the pipeline?
7. What render speed, peak total RAM/VRAM, and cancellation behavior are practical on target Windows hardware for 1080p30, 4K30, and 4K60?
8. What is the exact expected semantics of batch import: separate compositions, shared project, or both?
9. Is Canvas `renderFrame` included in the first release or deferred to a later adapter milestone?
10. Is WebM/VP9 alpha a first-release requirement or optional follow-up?

### Decisions requiring Product Owner approval

- Final Electron starting version and upgrade cadence (revisit against current stable/support policy at implementation time).
- Approval of a hybrid browser baseline (Electron preview + pinned headless shell render), with Option B experiment kept separate.
- Preview isolation choice after security spike results.
- Final MF Motion HTML/GSAP supported profile and unsupported-pattern behavior.
- Whether Canvas `renderFrame` mode is in the first release.
- Whether WebM/VP9 alpha is in the first release.
- Whether any embedded audio passthrough is required; audio editing/mixing remains out of scope in current PRD.
- FFmpeg binary provider/build and licensing path after engineering and legal review.
- Formal benchmark quality rubric and PO sign-off criteria.
- Minimum Windows hardware/performance target and acceptable render-time ratio.

---

## 11. Recommended next steps

1. Receive Antigravity's latest report for the most recent documentation-only correction task.
2. Compare the four actual files, not just the execution summary. Ensure Security Architecture and UI/UX corrections are synchronized with ADR and Architecture Blueprint.
3. Review ADRs one by one; retain explicit statuses (`Proposed`, `Pending Validation`, `Accepted by PM`, `Accepted by PO`, `Rejected`).
4. Decide whether Spike Test 4.1-A (browser/HyperFrames compatibility) is required before choosing the render topology.
5. Approve a separate Electron Security Spike before selecting the final preview isolation boundary.
6. Only after relevant ADRs and validation gates are approved, issue a bounded implementation task for the app foundation.
7. Keep benchmark regression, renderer parity, deterministic seek, alpha verification, clean Windows packaging, and security tests as release gates.

### Immediate stop conditions

- Do not mark Task 4.1 complete while draft documents contradict one another or contain known invalid API examples.
- Do not start broad application implementation without PM review and explicit PO approval.
- Do not commit or push Phase 4 documentation unless separately requested and reviewed.
- Do not delete or stage the eight Phase 3 scratch scripts without approval.
- Do not repeat POC work that has already been accepted unless a concrete regression or decision requires it.

---

## 12. Files to read first

| File | Why it matters |
|---|---|
| `AGENTS.md` | Non-negotiable implementation, security, workflow, and Git rules |
| `PRD.md` | Product vision, first-release scope, requirements, references, open PO decisions |
| `ROADMAP.md` | Phase gates and current progress |
| `TECHNICAL_DESIGN.md` | Provisional architecture and deterministic rendering contract |
| `TECHNOLOGY_EVALUATION.md` | Technology comparisons, risks, and POC rationale |
| `poc/hyperframes-spike/POC_FINAL_REVIEW.md` | Round 1 consolidated evidence and Phase 3 closure report |
| `poc/hyperframes-spike/reports/POC_ROUND2_REPORT.md` | Breaking News Round 2 metrics and caveats |
| `docs/phase4/PHASE4_TECHNOLOGY_ADR_DRAFT.md` | Current proposed technology decisions |
| `docs/phase4/PHASE4_ARCHITECTURE_BLUEPRINT_DRAFT.md` | Current subsystem architecture and quality-gate proposal |
| `docs/phase4/PHASE4_SECURITY_ARCHITECTURE_DRAFT.md` | Security threat model; known stale items listed in Section 8 above |
| `docs/phase4/PHASE4_UI_UX_BLUEPRINT_DRAFT.md` | UI/UX draft; known stale items listed in Section 8 above |

---

## 13. Latest archive contents and exclusions

The uploaded `MF Motion Gen.zip` contained the root project documentation and a nested `hyperframes-spike.zip`. The review intentionally did not depend on `node_modules`, `previews`, or `renders` folders, as requested by the Product Owner. The nested POC archive contains source, reports, tests, lockfiles, and some test artifacts; generated caches, snapshots, or binaries are not part of the project context decisions.

The ZIP is a project snapshot, not a Git repository export. It should not be used to infer remote synchronization or working-tree cleanliness without a fresh Git report.
