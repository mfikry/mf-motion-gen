# MF Motion Gen 2.0 — Product Requirements Document
**Status:** Draft 0.1 | **Version:** 2.0.0 | **Initial platform:** Windows desktop

## 1. Vision
MF Motion Gen is a desktop application for importing, validating, previewing, and rendering high-quality motion graphics authored externally as HTML-based projects (initially using Gemini AI Studio).

The initial product is an import, preview, and rendering studio—not a built-in text-to-motion generator.

## 2. Product principles
- Visual quality is a release gate; a successful export alone is not enough.
- Preview and exported video must match at identical timestamps.
- Rendering must be deterministic and seekable by absolute time.
- Imported projects are untrusted and must be isolated from privileged desktop APIs.
- V2 is a clean project; do not depend on V1 source, architecture, or runtime by default.

## 3. Main workflow
1. User authors a motion graphic in Gemini AI Studio and packages the result.
2. User imports the project into MF Motion Gen.
3. App validates the package and reports compatibility issues.
4. User previews, scrubs, and configures output.
5. App renders and exports video.
6. User can revise the source externally and re-import.

## 4. Initial must-have scope
- Import a documented, versioned HTML project package.
- Validate package structure, manifest, entry point, and assets.
- Preview, play/pause, and scrub/seek the timeline.
- Configure dimensions, FPS, duration, and approved export formats.
- Render frame-by-frame using explicit timestamps.
- Use the same runtime and assets for preview and export.
- Show progress, cancellation, and actionable errors.
- Save/reopen an MF Motion Gen project.
- Isolate imported content from privileged desktop capabilities.

## 5. Out of scope until approved
- Built-in prompt-to-motion generation or direct Gemini API integration.
- Full vector/motion-design editor.
- Automatic beautification of weak source HTML.
- Cloud collaboration/rendering, audio editing, or plugin marketplace.
- Guaranteeing compatibility with arbitrary websites or loose HTML files.

## 6. Proposed import package
Prefer a self-contained ZIP package over arbitrary loose HTML. Exact schema is TBD and must be validated in the prototype.

```text
motion-project.zip
├── mf-motion-project.json
├── index.html
├── src/
├── assets/
└── vendor/
```

Manifest should declare entry point, duration, dimensions/aspect ratio, and runtime-contract version. Local assets and dependencies should be packaged; external dependencies must be explicitly declared and approved.

## 7. Visual quality requirements
The user's supplied reference video(s) are the benchmark. Establish a fixed benchmark set and review:
- Composition and hierarchy
- Typography and legibility
- Asset quality and detail
- Color and contrast
- Motion choreography, pacing, and transitions
- Smoothness and frame consistency
- Effects and finishing
- Resolution and export artifacts

Two separate gates:
**Source-design gate:** the imported HTML itself meets or exceeds the reference.
**Rendering-fidelity gate:** MF Motion Gen reproduces the source without visual degradation, missing assets, timing drift, or glitches.

The renderer can preserve or degrade source quality; it cannot guarantee that weak source design becomes professional.

## 8. Non-functional requirements
- Stable rendering for declared duration and frame rate.
- No hidden internet dependency during render unless explicitly approved.
- Clear missing-asset, unsupported-feature, and runtime error reporting.
- Bounded CPU, memory, execution time, and package size (limits TBD).
- Safe handling of untrusted imported content.
- Reproducible output for identical package/settings/runtime, within documented tolerances.

## 9. Success criteria
Release candidate requires approved reference benchmarks, successful imports, preview/export parity, stable frame timing, validated output files, passing security/failure tests, and explicit product-owner approval.

## 10. Open decisions
- Exact reference videos and acceptance rubric.
- ZIP-only or ZIP plus folder import.
- Export formats, codecs, and alpha-channel requirements.
- Initial max resolution, duration, and FPS.
- Whether assets are copied into the project.
- Network access policy.
- Whether timeline editing beyond preview/scrubbing is required.
