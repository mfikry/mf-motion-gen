# MF Motion Gen 2.0 — Technical Design

**Status:** Draft 0.2 — provisional architecture pending POC  
**Architecture approach:** HTML-first desktop studio with an isolated deterministic renderer.

## 1. Proposed system

```text
Gemini AI Studio
      |
      v
Paste HTML / Import .html / Import folder or ZIP
      |
      v
Source + Asset Validator
      |
      v
MF Motion Contract Adapter
      |
      +------> Preview Runtime (isolated Chromium)
      |             |
      |             v
      |        Play / Pause / Seek
      |
      v
Render Worker Process
      |
      v
HyperFrames candidate engine
      |
      +--> Frame clock + seek adapter
      +--> Headless Chromium frame capture
      +--> FFmpeg encoding
      |
      v
MP4 / MOV / WebM
```

## 2. Provisional technology choices

| Layer | Candidate | Status |
|---|---|---|
| Desktop shell | Electron | Recommended for prototype |
| Frontend | React + TypeScript | Recommended for prototype |
| HTML rendering | HyperFrames + bundled/pinned Chromium | Primary engine candidate |
| Animation timeline | GSAP paused timeline | First supported animation contract |
| Frame capture | HyperFrames engine / Chrome BeginFrame | Primary candidate |
| Encoding | FFmpeg | Exact build/license must be audited |
| Project format | HTML + local assets, optional ZIP/folder | Recommended input approach |

These choices are not final until the proof of concept passes.

## 3. Input and project model

### 3.1 Input modes
- Paste complete HTML.
- Import one `.html` file.
- Batch import multiple `.html` files.
- Import a folder or ZIP containing HTML and local assets.
- Investigate a separate pure-JavaScript Canvas mode using `renderFrame(ctx, time, frame, totalFrames, config)`.

Batch import must clarify whether every HTML file represents a separate composition or whether multiple files form one linked project. The initial UX should avoid silent assumptions and report how files were grouped.

### 3.2 Asset rules
- Prefer local relative asset paths.
- Copy imported assets into the MF Motion Gen project directory so projects remain portable.
- Package fonts and images required by the composition.
- Default-deny runtime network access.
- Do not rely on external CDNs for scripts, fonts, image assets, or libraries.
- Report missing assets before preview/render.

## 4. MF Motion HTML contract (proposal)

The first authoring contract should align with the HyperFrames HTML composition model, while being versioned and owned by MF Motion Gen.

### Required concepts
- A composition root with unique composition ID and explicit width/height.
- A finite duration and target frame rate.
- A seekable paused animation timeline.
- An explicit readiness signal after fonts and visual assets are loaded.
- Local assets only for offline rendering.
- No unseeded random behavior or wall-clock-driven animation.
- No fetch/XHR/network calls during frame rendering.

### GSAP conventions
- Create GSAP timelines as paused.
- Use absolute timeline positions for animation choreography.
- Register the timeline under the composition ID in the expected runtime registry.
- Frame seeking is performed by the renderer, not by real-time playback.

See the HyperFrames HTML schema and GSAP guide. The exact accepted profile should be tested and documented before building the importer.

### Canvas mode
If the POC retains the `renderFrame(ctx, time, frame, totalFrames, config)` mode, implement it as a separate MF Motion adapter. Do not force it into the same schema as full DOM/HTML projects.

## 5. Deterministic render contract

Canonical frame time:

```js
const timeSeconds = frameIndex / fps;
```

Required behavior:
- The requested frame can be rendered in any order.
- Seeking to the same frame twice yields the same visual output.
- No timing based on `Date.now()`, real-time `requestAnimationFrame`, or system timers.
- No unseeded randomness.
- No network fetch during rendering.
- All required fonts/images/media are ready before capture.
- Fixed width, height, FPS, and finite duration before frame 0.
- `seekFrame(frame)` only resolves when the requested frame is fully ready to capture.

HyperFrames documents this model, but MF Motion Gen must still run its own conformance tests.

## 6. Preview/render parity

Preview and export must use the same:
- HTML composition and local asset tree.
- Animation adapter and seek semantics.
- Chromium build and rendering settings, where possible.
- Viewport dimensions and device scale factor.
- Font files and font loading behavior.
- Color-space/background/alpha behavior.

The Electron UI's own embedded Chromium must not silently become a different renderer from the pinned capture Chromium. The POC should test whether preview should use the same bundled Chromium launched in headed mode, while final export uses it in headless mode.

## 7. Process boundaries and security

The main Electron app must not execute imported HTML with privileged access.

Baseline:
- Dedicated render process and isolated Chromium context.
- `nodeIntegration: false`.
- `contextIsolation: true`.
- Chromium process sandbox enabled.
- No privileged preload bridge exposed to imported content.
- Strict CSP and default-deny network.
- Block navigation, popups, downloads, permission prompts, and external protocols unless explicitly approved.
- No direct filesystem/shell/process/credential access from imported content.
- Validate archive paths and block path traversal.
- Apply execution timeout, memory/resource limits, project-size limits, and cancellation.
- On a hung/crashed render, terminate and recreate the render worker without crashing the app.

Electron's own security documentation warns that arbitrary untrusted content is a severe risk. These controls must be threat-modelled and penetration-tested; a browser process alone is not a guarantee of safety.

## 8. Rendering and export

### Candidate pipeline
- HyperFrames producer/engine for controlled frame capture.
- FFmpeg for encoding and optional post-processing.
- Separate render worker process to protect UI responsiveness and allow cancellation/restart.

### Output targets
- MP4/H.264, opaque background.
- MOV/ProRes 4444, transparent background where required.
- WebM/VP9 alpha as an optional browser-oriented format.

The HyperFrames CLI documents MP4, MOV, and WebM output; the producer API documentation currently lists programmatic MP4 and WebM configuration. Validate MOV support through the exact integration API or use a tested encoding stage. Do not assume CLI and producer capabilities are identical.

### Performance target
Benchmark:
- 1920×1080 @ 30 fps
- 3840×2160 @ 30 fps
- 3840×2160 @ 60 fps

The reference set includes 4K30 and 4K60. These become test targets, not assumed performance promises.

## 9. Adapter layer and dependency strategy

- Create an MF Motion Gen internal renderer interface.
- Keep HyperFrames-specific types inside one adapter module.
- Pin exact tested versions of HyperFrames packages and their browser binary.
- Add conformance tests for repeatability, random seek order, bounds, duration, readiness, and cleanup.
- Track the Frame Adapter API's experimental v0 status; do not let the API leak through app-level state.
- Track all runtime binaries and third-party licenses.

## 10. FFmpeg and licensing controls

- HyperFrames repository identifies its framework as Apache 2.0.
- GSAP currently advertises commercial use at no charge under its Standard License; review the live terms before release.
- FFmpeg's default license is LGPL 2.1-or-later, but enabling optional GPL/nonfree components changes obligations.
- Audit the exact FFmpeg binary, build flags, codec libraries, and source/notice distribution before shipping.
- Do not bundle unknown third-party FFmpeg binaries.

## 11. Technical spike

Before the app shell is built, create a small prototype that:
1. Imports one standalone HTML composition.
2. Imports one HTML project with local font/image assets.
3. Creates a paused GSAP timeline and seeks to arbitrary frames.
4. Previews the composition in a visible Chromium instance.
5. Renders a complete MP4 frame-by-frame.
6. Compares preview screenshots with exported frames.
7. Repeats the render to check determinism.
8. Exports a transparent MOV through the planned integration route.
9. Tests 1080p30, 4K30, and 4K60.
10. Tests multiple HTML imports and Canvas function mode.
11. Tests blocked network access, path traversal, timeouts, cancellation, renderer crash, and recovery.

## 12. Decision gate

Do not approve full production architecture until the spike passes:
- Visual quality benchmark.
- Deterministic seek and repeatability.
- Preview/export parity.
- Local asset portability.
- Windows performance.
- Security isolation.
- Output/codec and licensing validation.
