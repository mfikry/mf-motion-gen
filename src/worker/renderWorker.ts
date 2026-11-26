import {
  PINNED_RUNTIME,
  type MainToWorkerMessage,
  type WorkerToMainMessage,
} from "../shared/renderContracts.js";
import { HyperFramesProducerAdapter } from "./adapters/hyperFramesProducerAdapter.js";

interface ActiveJobEntry {
  controller: AbortController;
  cancelled: boolean;
}

const adapter = new HyperFramesProducerAdapter();
const activeJobs = new Map<string, ActiveJobEntry>();

let channelPort: Electron.MessagePortMain | null = null;
let readyEmitted = false;

function assertWorkerJobActive(jobId: string): void {
  const entry = activeJobs.get(jobId);
  if (!entry || entry.cancelled || entry.controller.signal.aborted) {
    throw new Error("WORKER_JOB_INACTIVE_OR_ABORTED");
  }
}

function sendToHost(msg: WorkerToMainMessage): void {
  if (channelPort) {
    channelPort.postMessage(msg);
  } else if (process.parentPort) {
    process.parentPort.postMessage(msg);
  }
}

async function handleHostMessage(msg: MainToWorkerMessage): Promise<void> {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "ping") {
    sendToHost({
      type: "pong",
      seq: msg.seq,
      pid: process.pid,
      receivedAtMs: Date.now(),
    });
    return;
  }

  if (msg.type === "cancelRender") {
    const entry = activeJobs.get(msg.jobId);
    if (entry && !entry.cancelled) {
      entry.cancelled = true;
      entry.controller.abort(new Error(msg.reason || "USER_CANCELLED"));
    }
    return;
  }

  if (msg.type === "startRender") {
    const { request } = msg;
    if (activeJobs.has(request.jobId)) {
      sendToHost({
        type: "failed",
        result: {
          jobId: request.jobId,
          status: "failed",
          outcome: "failed",
          outputPath: request.outputPath,
          wallMs: 0,
          framesRendered: null,
          totalFrames: null,
          warnings: [],
          errorName: "DuplicateJobError",
          errorMessage: `Job "${request.jobId}" is already active in worker`,
        },
      });
      return;
    }

    const controller = new AbortController();
    activeJobs.set(request.jobId, { controller, cancelled: false });

    try {
      const result = await adapter.render(request, controller.signal, {
        assertWorkerJobActive,
        onProgress: (event) => {
          sendToHost({ type: "progress", event });
        },
        onChildProcessTracked: (childPid, command) => {
          sendToHost({
            type: "childProcessTracked",
            jobId: request.jobId,
            childPid,
            command,
          });
        },
      });

      if (result.status === "complete") {
        sendToHost({ type: "complete", result });
      } else {
        sendToHost({ type: "failed", result });
      }
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      sendToHost({
        type: "failed",
        result: {
          jobId: request.jobId,
          status: "failed",
          outcome: "failed",
          outputPath: request.outputPath,
          wallMs: 0,
          framesRendered: null,
          totalFrames: null,
          warnings: [],
          errorName: e.name,
          errorMessage: e.message,
        },
      });
    } finally {
      activeJobs.delete(request.jobId);
    }
  }
}

if (!process.parentPort) {
  throw new Error("renderWorker must run inside Electron utilityProcess");
}

process.on("uncaughtException", (err) => {
  sendToHost({
    type: "workerInternalError",
    message: err?.message || String(err),
    stack: err?.stack,
  });
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  sendToHost({
    type: "workerInternalError",
    message: err.message,
    stack: err.stack,
  });
});

process.parentPort.on("message", (event) => {
  const data = event?.data as { type?: string } | MainToWorkerMessage;
  if (data?.type === "init" && event.ports && event.ports[0]) {
    channelPort = event.ports[0];
    channelPort.on("message", (portEvent) => {
      void handleHostMessage(portEvent.data as MainToWorkerMessage);
    });
    channelPort.start();
    if (!readyEmitted) {
      readyEmitted = true;
      sendToHost({
        type: "ready",
        pid: process.pid,
        nodeVersion: process.version,
        electronVersion: process.versions.electron ?? null,
        pinnedRuntime: PINNED_RUNTIME,
      });
    }
    return;
  }

  void handleHostMessage(data as MainToWorkerMessage);
});
