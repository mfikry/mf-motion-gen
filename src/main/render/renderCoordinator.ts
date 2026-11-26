import fs from "node:fs";
import path from "node:path";
import type {
  PreflightResult,
  RenderJobRequest,
  RenderProgressEvent,
} from "../../shared/renderContracts.js";
import { validateCompositionPreflight } from "../validation/hostPreflightValidator.js";
import { RenderWorkerHost, type WorkerRenderExecution } from "./renderWorkerHost.js";

export class RenderPreflightError extends Error {
  readonly preflight: PreflightResult;

  constructor(preflight: PreflightResult) {
    const summary = preflight.blockers.map((b) => `[${b.code}] ${b.message}`).join("; ");
    super(`Composition failed Host-Side Preflight check: ${summary}`);
    this.name = "RenderPreflightError";
    this.preflight = preflight;
  }
}

export interface CoordinatedRenderOutcome {
  preflight: PreflightResult;
  execution: WorkerRenderExecution;
}

/**
 * High-level Main Process coordinator coupling Host-Side Preflight validation
 * with isolated RenderWorkerHost execution.
 */
export class RenderCoordinator {
  readonly host: RenderWorkerHost;

  constructor(host?: RenderWorkerHost) {
    this.host = host ?? new RenderWorkerHost();
  }

  async render(
    request: RenderJobRequest,
    onProgress?: (event: RenderProgressEvent) => void
  ): Promise<CoordinatedRenderOutcome> {
    const preflight = validateCompositionPreflight(request.stageDir, {
      entryFile: request.entryFile ?? "index.html",
    });

    if (!preflight.ok) {
      throw new RenderPreflightError(preflight);
    }

    fs.mkdirSync(path.dirname(path.resolve(request.outputPath)), { recursive: true });
    const execution = await this.host.render(
      { ...request, stageDir: preflight.stageDir },
      onProgress
    );

    return { preflight, execution };
  }

  cancel(jobId: string, reason?: string): boolean {
    return this.host.cancelJob(jobId, reason);
  }

  async shutdown(): Promise<void> {
    await this.host.disposeWorkerTree();
  }
}
