# MF Motion Gen 2.0 — Product Requirements Document

**Status:** Draft 0.2  
**Product:** MF Motion Gen  
**Version:** 2.0.0  
**Initial platform:** Windows desktop

## 1. Product vision

MF Motion Gen is a desktop application for importing, validating, previewing, and rendering high-quality motion graphics authored externally as HTML-based projects (initially through Gemini AI Studio).

The initial product is an HTML motion-project import, preview, and render studio. Built-in prompt-to-motion generation and a full visual motion editor are not part of the initial scope.

## 2. Product principles

1. Visual quality is a release gate, not a cosmetic bonus.
2. Preview and exported output must match at equivalent timestamps.
3. Final rendering must be frame-driven and seekable by absolute frame/time.
4. Imported projects must be portable; required assets should be local and packaged.
5. Imported HTML/JavaScript is untrusted and must not receive privileged desktop access.
6. V2 is a clean project independent of V1.

## 3. Main workflow

1. User creates motion graphics in Gemini AI Studio.
2. User pastes the generated HTML or imports one/multiple `.html` files.
3. If the source uses local images/fonts/assets, user imports the associated project folder or ZIP package.
4. MF Motion Gen validates the source and reports compatibility issues.
5. User previews, plays, pauses, scrubs, and seeks the timeline.
6. User selects output resolution, frame rate, duration, and format.
7. MF Motion Gen renders and exports the final video.
8. User can revise the source externally and re-import.

## 4. Initial input modes

### Required input UX
- Paste complete HTML source (including inline CSS and JavaScript).
- Import one `.html` file.
- Batch import multiple `.html` files.
- Import a project folder or ZIP when assets or multiple linked files are required.
- Show detected title/name, dimensions, duration, frame rate metadata (when provided), and validation status.

### Supported source contract
The first supported HTML profile should be deliberately narrow and deterministic:
- A root composition declares its unique ID, width, and height.
- Animation duration is finite and explicit.
- All animation is controllable at an absolute frame/time.
- GSAP timelines are paused and registered for frame seeking.
- Fonts, images, SVGs, scripts, and other required assets resolve locally.
- No runtime network fetching is required.
- A readiness signal is exposed after fonts and visual assets are loaded.

A generic HTML file may be previewable but should not be marked render-ready until it passes the contract checks.

### Canvas JavaScript mode (candidate)
The existing UI reference includes a pure-JavaScript function signature:

```js
function renderFrame(ctx, time, frame, totalFrames, config) {
  // Draw one frame for the requested time.
}
```

Keep this as a separate adapter/mode to investigate during the technical spike. Do not silently treat it as identical to full HTML rendering.

## 5. Initial feature scope

### Must have for the first usable release
- Simple paste/import UI.
- Single and batch `.html` import.
- Folder/ZIP asset import.
- Package/source validation and actionable error reporting.
- Preview, play/pause, scrub, and arbitrary-time seek.
- Resolution, FPS, duration, and export format controls.
- Frame-by-frame rendering.
- Preview/export parity.
- Render progress, cancellation, failure details, and logs.
- Project save/reopen.
- Safe isolation for imported content.

### Out of scope until approved
- Built-in AI prompt-to-motion generation or direct Gemini API.
- Full keyframe/vector editor.
- Automatic beautification of weak source HTML.
- Cloud collaboration or cloud rendering.
- Audio editing/mixing in the initial release.
- Unrestricted support for arbitrary websites or arbitrary HTML/JavaScript.

## 6. Reference benchmark set

The user supplied seven videos. Current observed technical metadata:

| Reference type | Duration | Resolution | Frame rate |
|---|---:|---:|---:|
| World clocks | 10 s | 832×464 | ~59.7 fps average |
| Progress bar | 10 s | 832×464 | ~59.7 fps average |
| Countdown | 10 s | 3840×2160 | 30 fps |
| Wi-Fi icon (green-screen source) | 8 s | 3840×2160 | 60 fps |
| Breaking news | 10 s | 1024×576 | 30 fps |
| System breach / warning | 10 s | 3840×2160 | 60 fps |
| Low battery | 10 s | 3840×2160 | 30 fps |

These references test typography, precision shapes, progress/timer behavior, glow, glitch, visual hierarchy, and multiple output settings. The five 4K references establish a high-resolution quality target; the two lower-resolution clips remain useful motion/design references.

## 7. Visual quality gates

**A. Source-design quality:** the generated HTML itself meets or exceeds the reference standard for composition, design detail, typography, contrast, pacing, transitions, and polish.

**B. Render fidelity:** MF Motion Gen reproduces the approved HTML source without missing assets, visual degradation, timing drift, frame glitches, or export artifacts.

The renderer can preserve or degrade a source. It cannot automatically turn weak art direction into professional motion design. These gates must be judged separately.

## 8. Output targets to validate

- MP4 / H.264 for standard delivery.
- MOV / ProRes 4444 for transparent video workflows.
- WebM / VP9 alpha as a secondary transparent output.
- 1920×1080 at 30 fps as a baseline.
- 3840×2160 at 30 fps and 60 fps as high-end benchmark targets.

These are target capabilities, not yet verified performance guarantees. The prototype must demonstrate them on the target Windows environment.

## 9. Non-functional requirements

- Deterministic output for identical project, settings, and pinned renderer version, within defined tolerances.
- No hidden network dependency during preview/render unless explicitly approved.
- Local, reproducible font and asset loading.
- Bounded CPU, memory, execution time, and project size.
- Clear error messages for unsupported animation behavior.
- Safe handling of untrusted source code.
- No silent truncation or dropped frames.

## 10. Success criteria

A release candidate is acceptable only when:
- The owner-approved reference benchmark set has been tested.
- Supported HTML projects import successfully.
- Arbitrary seeking works (including backward and random seeks).
- Preview and export match at sampled timestamps.
- Repeated rendering is visually deterministic.
- 4K/30 and 4K/60 tests are complete with documented performance.
- MP4 and transparent MOV output are validated.
- Security, cancellation, recovery, and failure tests pass.
- The product owner approves the final visual results.

## 11. Open decisions

- Final import contract and whether the Canvas `renderFrame` adapter is included in the first release.
- Final HTML file/folder/ZIP UX.
- Whether WebM alpha is required in the first release.
- Exact quality rubric and who approves each benchmark.
- Hardware/performance target and acceptable render-time ratio.
