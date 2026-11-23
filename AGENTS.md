# AGENTS.md — MF Motion Gen 2.0

## Project identity
- Product name: **MF Motion Gen**
- Version: **2.0**
- Windows desktop target.
- This is a clean V2 project. V1 source and architecture are not a baseline unless the product owner explicitly approves reuse.

## Roles and workflow
- ChatGPT: Project Manager, Technical Architect, reviewer.
- User: Product Owner and decision approver.
- Antigravity: implementation agent.
- Claude continues work on V1 separately.

## Product direction
The initial workflow is:
1. User authors motion graphics externally (initially Gemini AI Studio).
2. User pastes/imports HTML or imports a project containing local assets.
3. MF Motion Gen validates and previews the composition.
4. User seeks through the timeline and selects output settings.
5. MF Motion Gen renders and exports video.

This is initially an import, preview, and rendering studio—not a built-in text-to-motion editor.

## Current technical recommendation
Electron + React/TypeScript UI, with HyperFrames as the leading HTML-to-video engine candidate, GSAP as the first seekable animation contract, and FFmpeg for encoding.

This recommendation is provisional. Do not begin broad implementation until the POC and technical decision gate are approved. HyperFrames Frame Adapter API is currently experimental; pin versions and hide it behind an MF internal adapter.

## Non-negotiable requirements
- Visual quality is a release gate against user-provided reference videos.
- Preview and export must match at equal timestamps.
- Rendering must use deterministic, absolute frame seeking.
- Imported HTML/JS is untrusted and must be isolated from privileged app capabilities.
- No arbitrary HTML compatibility claims without a documented and tested support contract.
- No V1 code or architecture reuse by default.

## Implementation workflow
Before substantial coding, provide:
1. Understanding of the requirement.
2. Proposed implementation and why.
3. Affected modules/files.
4. Risks and edge cases.
5. Test and acceptance plan.

Follow approved PRD, technical design, technology evaluation, ADRs, and issues. Do not silently change product scope, import contract, runtime, or dependency choices. Prefer small reviewable changes. Explain dependency additions and review maintenance, license, and security implications. Do not claim success without test evidence.

## HTML and rendering rules
- Target a documented MF Motion HTML profile.
- Prefer paused GSAP timelines with deterministic seek.
- Do not depend on wall-clock timers, unseeded randomness, or render-time external network assets.
- Ensure local fonts and images are ready before capture.
- Arbitrary HTML is not automatically render-ready.
- Keep Canvas `renderFrame` mode separate if it is adopted.

## Quality and testing
- Compare output against approved benchmark videos.
- Test first/last frame, transitions, and representative middle frames.
- Test random/backward seeks and repeat rendering.
- Compare preview captures and exported frames at identical timestamps.
- Benchmark 1080p30, 4K30, and 4K60.
- Test transparent MOV output if included.
- Test missing assets, font failures, runtime exceptions, cancellation, timeouts, process crash, and recovery.
- Report limitations honestly.

## Security baseline
- Treat imported HTML, JavaScript, CSS, SVG, images, and archives as untrusted.
- Never expose Node, filesystem, shell, process, credentials, or privileged IPC to imported content.
- Use a separate renderer process/context, Chromium sandboxing, context isolation, restrictive CSP, and default-deny network access.
- Disable unrestricted navigation, popups, downloads, and permission prompts.
- Validate archive paths and enforce project-size, memory, and execution-time limits.
- Do not treat a Web Worker or browser sandbox alone as a complete security strategy.

## Git hygiene
- Use feature branches for non-trivial changes.
- Use descriptive commits.
- Never force-push or rewrite shared history without approval.
- Do not commit secrets, local caches, build outputs, or user-generated renders unless explicitly required.
