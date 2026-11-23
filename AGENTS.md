# AGENTS.md — MF Motion Gen 2.0

## Identity
- Product: **MF Motion Gen**
- Version: **2.0**
- This is a clean V2 repository.
- Do not copy, depend on, or assume compatibility with V1 unless the product owner explicitly approves it.

## Roles
- ChatGPT: Project Manager, Technical Architect, reviewer.
- User: Product Owner and approver of scope/major decisions.
- Antigravity: implementation agent.
- Claude continues to own V1 separately.

## Product direction
Intended workflow: author motion externally (initially Gemini AI Studio) as an HTML-based project → import into MF Motion Gen → validate → preview/seek → render → export.

Initially this is an import, preview, and rendering studio—not built-in prompt-to-motion generation.

## Non-negotiable requirements
- Visual quality is a release gate against user-provided reference videos.
- Preview and export must match.
- Rendering must support deterministic absolute-time seeking.
- Imported projects are untrusted and must be isolated from privileged desktop capabilities.
- No V1 architecture or source reuse by default.
- Do not claim arbitrary HTML compatibility without a documented, tested contract.

## Implementation workflow
Before substantial coding, provide:
1. Understanding of the requirement.
2. Proposed implementation.
3. Affected files/modules.
4. Risks and edge cases.
5. Test and acceptance plan.

Follow approved PRD, technical design, ADRs, and issues. Do not silently change scope, architecture, package schema, or runtime contract. Prefer small reviewable changes. Explain dependency additions and review maintenance, licensing, and security. Keep secrets out of source control and logs. Do not claim success without running tests or presenting evidence.

## Quality/testing
- Check visual changes against approved benchmark projects.
- Test exact timestamps, not only real-time playback.
- Test first frame, last frame, transitions, and representative midpoints.
- Test missing assets, font failures, runtime exceptions, cancellation, and repeated renders.
- Compare preview captures and exported frames at identical timestamps.
- Report limitations honestly.

## Security baseline
- Treat imported HTML, JavaScript, CSS, SVG, images, and archives as untrusted.
- Never expose Node, filesystem, shell, process, credentials, or privileged IPC to imported content.
- Use restrictive CSP and default-deny network access unless explicitly approved.
- Validate archive paths and enforce resource/time limits.
- Do not treat a Web Worker alone as a complete sandbox.

## Git hygiene
- Use feature branches for non-trivial changes.
- Use descriptive commits.
- Never force-push or rewrite shared history without explicit approval.
- Do not commit secrets, local caches, build outputs, or user-generated renders unless required.
