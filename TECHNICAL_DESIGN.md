# MF Motion Gen 2.0 — Technical Design
**Status:** Draft 0.1. Candidate architecture only; not frozen.

## 1. Proposed system
```text
HTML Motion Package
        |
Import + Package Validator
        |
Isolated Preview Runtime
        |
Timeline / Preview Controls
        |
Deterministic Frame Capture
        |
Video Encoder / Export
```

Initial hypothesis: a Chromium-based HTML runtime plus a controlled time interface and a separate encoding stage. This must be proven before selecting the final stack.

## 2. Import package
- Treat every package as untrusted.
- Validate ZIP paths to prevent path traversal.
- Validate manifest version, entry page, and declared assets.
- Resolve assets from the package, not arbitrary machine paths.
- Report missing assets and unsupported dependencies.
- Reject unsupported or unexpected executable content.

## 3. Runtime and security
- Run imported content in a dedicated isolated renderer context.
- Disable Node integration and privileged preload access.
- Use context isolation and Chromium sandboxing where applicable.
- Do not expose filesystem, shell, credentials, OS APIs, or privileged IPC.
- Apply restrictive Content Security Policy.
- Default-deny network access; exceptions require explicit approval.
- Enforce execution, memory, package-size, and render-time limits.

A Web Worker alone is not a complete security boundary for arbitrary HTML. Threat-model and test the actual isolation model.

## 4. Deterministic time contract
Rendering must request frames at absolute timestamps rather than waiting for real-time playback.

Conceptual proposal (API names are not final):
```js
window.motionProject = {
  metadata: { duration: 8, width: 1920, height: 1080, fps: 30 },
  renderAt: async (timeSeconds) => {
    // Set all animated elements to this absolute time.
    // Resolve only when the frame is ready to capture.
  }
};
```

Requirements:
- Repeatable, seekable `renderAt(t)`.
- No dependence on wall-clock time.
- Wait for fonts, images, and async visual assets.
- Explicitly support and test each animation mechanism (CSS, Web Animations API, GSAP, Canvas, WebGL) rather than assuming all are controllable.
- Seed or disable randomness.
- Signal when a frame is ready.
- Detect projects that violate the contract.

Arbitrary HTML animations are not automatically deterministic. A compatibility adapter/contract is required.

## 5. Preview/render parity
Preview and export should share runtime version, package/assets, viewport, device-scale policy, color-space policy, time-control implementation, and font-loading behavior. Any preview proxy-resolution difference must not alter layout or motion.

## 6. Candidate technology areas
| Area | Candidates | Proof required |
|---|---|---|
| Desktop shell | Electron / Tauri | Isolation, Windows packaging, maintainability |
| HTML runtime | Chromium / WebView | HTML, CSS, SVG, Canvas, and required WebGL fidelity |
| Animation control | GSAP / Web Animations API / adapter | Exact seeking |
| Encoding | FFmpeg | Stable frame-sequence encoding and licensing |
| Package | ZIP + JSON manifest | Portability and validation |
| UI | React + TypeScript (candidate) | Timeline, import, settings, progress |

No technology is approved merely because it is popular. Prototype evidence and license/security review decide.

## 7. Prototype plan
Create a small spike before full application development. Test:
1. HTML/CSS typography and layout.
2. SVG paths and transforms/morphing.
3. Canvas 2D.
4. WebGL if included in support target.
5. Local images and fonts.
6. Staggered timelines and easing.
7. Runtime errors and missing assets.
8. Attempts at network or privileged access.

The spike must prove import, validation, arbitrary-time seek, frame capture, full video render, preview/export comparison, repeat-render determinism, safe isolation, cancellation, and recovery from hangs.

## 8. Architecture decision records
Record options, evidence, trade-offs, decision, and consequences for:
- Desktop shell
- Runtime and isolation model
- Package/manifest format
- Deterministic animation contract
- Frame capture
- Encoder/export formats
- Supported animation APIs/libraries
- Dependency and licensing policy

## 9. Risks
- Arbitrary HTML may not be seekable/deterministic.
- External fonts, images, scripts, and APIs harm portability.
- Browser/runtime and GPU-driver differences can change output.
- High-resolution capture can consume substantial memory.
- Renderer cannot repair weak source art direction.
- Security restrictions may break projects relying on unrestricted browser features.

## 10. Technical readiness gate
Do not freeze architecture until the prototype proves deterministic seeking, benchmark fidelity, preview/export parity, local asset portability, safe isolation, and acceptable performance on target Windows hardware.
