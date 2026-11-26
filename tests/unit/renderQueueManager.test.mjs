import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { purgeSessionDirectorySync } from "../../dist/main/import/sessionFsUtils.js";
import {
  DEFAULT_MAX_RENDER_QUEUE_CAPACITY,
  MAX_ALLOWED_RENDER_QUEUE_CAPACITY,
  RenderQueueError,
  RenderQueueManager,
} from "../../dist/main/render/renderQueueManager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const tmpRoot = path.join(repoRoot, "tmp", "unit-ws-a-queue");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function makeStageDir(name) {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), "<html><body></body></html>", "utf8");
  return dir;
}

function makeRequest(jobId, stageDir, format = "mp4") {
  return {
    jobId,
    stageDir,
    entryFile: "index.html",
    outputPath: path.join(tmpRoot, "out", `${jobId}.${format}`),
    format,
    quality: "draft",
    fps: { num: 30, den: 1 },
  };
}

describe("Workstream A — Sequential RenderQueueManager & Session Binding", () => {
  before(() => {
    purgeSessionDirectorySync(tmpRoot);
    fs.mkdirSync(tmpRoot, { recursive: true });
  });

  after(() => {
    purgeSessionDirectorySync(tmpRoot);
  });

  it("1. enforces strict FIFO execution with max 1 concurrent worker", async () => {
    const stageDir = makeStageDir("session-fifo");
    const started = [];
    const finished = [];
    let inFlight = 0;
    let maxInFlight = 0;

    const runner = {
      async render(req) {
        started.push(req.jobId);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await sleep(30);
        inFlight -= 1;
        finished.push(req.jobId);
        return {
          preflight: { ok: true, blockers: [], warnings: [] },
          execution: {
            result: {
              jobId: req.jobId,
              status: "complete",
              outcome: "completed",
              outputPath: req.outputPath,
              wallMs: 30,
              framesRendered: 30,
              totalFrames: 30,
              warnings: [],
            },
            workerPid: 1001,
            trackedChildPids: [],
            cleanupActions: [],
            survivingOrphans: 0,
          },
        };
      },
      cancel() {
        return false;
      },
    };

    const queue = new RenderQueueManager({ runner });
    assert.equal(queue.maxQueueCapacity, DEFAULT_MAX_RENDER_QUEUE_CAPACITY);
    assert.ok(DEFAULT_MAX_RENDER_QUEUE_CAPACITY > 0 && DEFAULT_MAX_RENDER_QUEUE_CAPACITY <= MAX_ALLOWED_RENDER_QUEUE_CAPACITY);

    const j1 = queue.enqueue({ sessionId: "s1", title: "Comp 1", request: makeRequest("job-1", stageDir) });
    const j2 = queue.enqueue({ sessionId: "s1", title: "Comp 2", request: makeRequest("job-2", stageDir, "mov") });
    const j3 = queue.enqueue({ sessionId: "s1", title: "Comp 3", request: makeRequest("job-3", stageDir) });

    const results = await Promise.all([j1.completion, j2.completion, j3.completion]);
    assert.deepEqual(started, ["job-1", "job-2", "job-3"]);
    assert.deepEqual(finished, ["job-1", "job-2", "job-3"]);
    assert.equal(maxInFlight, 1);
    assert.equal(queue.getMaxObservedConcurrency(), 1);
    assert.ok(results.every((r) => r.status === "complete"));
  });

  it("2. enforces bounded queue capacity cleanly", async () => {
    const stageDir = makeStageDir("session-bounded");
    let releaseFirst;
    const firstGate = new Promise((r) => {
      releaseFirst = r;
    });

    const runner = {
      async render(req) {
        if (req.jobId === "b-1") await firstGate;
        return {
          preflight: { ok: true, blockers: [], warnings: [] },
          execution: {
            result: {
              jobId: req.jobId,
              status: "complete",
              outcome: "completed",
              outputPath: req.outputPath,
              wallMs: 5,
              framesRendered: 10,
              totalFrames: 10,
              warnings: [],
            },
            workerPid: 1002,
            trackedChildPids: [],
            cleanupActions: [],
            survivingOrphans: 0,
          },
        };
      },
      cancel() {
        return false;
      },
    };

    const queue = new RenderQueueManager({ runner, maxQueueCapacity: 2 });
    const a = queue.enqueue({ sessionId: "s-cap", title: "A", request: makeRequest("b-1", stageDir) });
    const b = queue.enqueue({ sessionId: "s-cap", title: "B", request: makeRequest("b-2", stageDir) });

    assert.throws(
      () => queue.enqueue({ sessionId: "s-cap", title: "C", request: makeRequest("b-3", stageDir) }),
      (err) => err instanceof RenderQueueError && err.code === "RENDER_QUEUE_FULL"
    );

    releaseFirst();
    await Promise.all([a.completion, b.completion]);

    // Capacity frees cleanly after completion
    const d = queue.enqueue({ sessionId: "s-cap", title: "D", request: makeRequest("b-4", stageDir) });
    const dRes = await d.completion;
    assert.equal(dRes.status, "complete");
  });

  it("3. supports selective cancellation (queued without stopping active, active cancel with tree cleanup + queue advance, and auto-advance after failure)", async () => {
    const stageDir = makeStageDir("session-cancel");
    const activeCancels = new Map();
    const cancelReasons = {};

    const runner = {
      async render(req) {
        let cancelTrigger;
        const waitCancel = new Promise((resolve) => {
          cancelTrigger = resolve;
        });
        activeCancels.set(req.jobId, cancelTrigger);

        if (req.jobId === "fail-job") {
          throw new Error("Simulated worker crash");
        }

        const outcome = await Promise.race([
          sleep(req.jobId.startsWith("active-cancel") ? 500 : 35).then(() => "done"),
          waitCancel.then(() => "cancelled"),
        ]);

        return {
          preflight: { ok: true, blockers: [], warnings: [] },
          execution: {
            result: {
              jobId: req.jobId,
              status: outcome === "cancelled" ? "cancelled" : "complete",
              outcome: outcome === "cancelled" ? "cancelled" : "completed",
              outputPath: req.outputPath,
              wallMs: 20,
              framesRendered: outcome === "cancelled" ? 3 : 30,
              totalFrames: 30,
              warnings: [],
              errorReason: outcome === "cancelled" ? cancelReasons[req.jobId] : undefined,
            },
            workerPid: 2000,
            trackedChildPids: [],
            cleanupActions: [],
            survivingOrphans: 0,
          },
        };
      },
      cancel(jobId, reason) {
        cancelReasons[jobId] = reason;
        const trigger = activeCancels.get(jobId);
        if (trigger) {
          trigger();
          return true;
        }
        return false;
      },
    };

    const queue = new RenderQueueManager({ runner });

    // Part A: enqueue active j1, queued j2 (to cancel), failing j3, healthy j4
    const j1 = queue.enqueue({ sessionId: "s-c", title: "J1", request: makeRequest("j1", stageDir) });
    const j2 = queue.enqueue({ sessionId: "s-c", title: "J2", request: makeRequest("j2-queued", stageDir) });
    const j3 = queue.enqueue({ sessionId: "s-c", title: "J3", request: makeRequest("fail-job", stageDir) });
    const j4 = queue.enqueue({ sessionId: "s-c", title: "J4", request: makeRequest("j4", stageDir) });

    // Cancel j2 while still queued: must NOT disturb j1
    const qCancel = queue.cancel("j2-queued", "removed_from_queue");
    assert.deepEqual(qCancel, { cancelled: true, wasActive: false });

    const [r1, r2, r3, r4] = await Promise.all([j1.completion, j2.completion, j3.completion, j4.completion]);
    assert.equal(r1.status, "complete");
    assert.equal(r2.status, "cancelled");
    assert.equal(r2.errorReason, "removed_from_queue");
    assert.equal(r3.status, "failed");
    assert.equal(r4.status, "complete");

    // Part B: cancel active rendering job -> worker aborted and queue auto-advances to next queued item
    const a1 = queue.enqueue({ sessionId: "s-c", title: "A1", request: makeRequest("active-cancel-1", stageDir) });
    const a2 = queue.enqueue({ sessionId: "s-c", title: "A2", request: makeRequest("after-cancel-2", stageDir) });
    await sleep(15);
    const activeCancelRes = queue.cancel("active-cancel-1", "abort_active");
    assert.deepEqual(activeCancelRes, { cancelled: true, wasActive: true });

    const [ra1, ra2] = await Promise.all([a1.completion, a2.completion]);
    assert.equal(ra1.status, "cancelled");
    assert.equal(ra1.errorReason, "abort_active");
    assert.equal(ra2.status, "complete");
  });

  it("4. invalidates queued & active session jobs before temp purge and blocks stale session paths", async () => {
    const dirA = makeStageDir("session-a-temp");
    const dirB = makeStageDir("session-b-temp");
    let activeSessionId = "session-A";
    const ranJobs = [];
    let abortActive;

    const runner = {
      async render(req) {
        ranJobs.push({ jobId: req.jobId, stageDir: req.stageDir });
        let cancelled = false;
        await new Promise((resolve) => {
          abortActive = () => {
            cancelled = true;
            resolve();
          };
          setTimeout(resolve, 400);
        });
        return {
          preflight: { ok: true, blockers: [], warnings: [] },
          execution: {
            result: {
              jobId: req.jobId,
              status: cancelled ? "cancelled" : "complete",
              outcome: cancelled ? "cancelled" : "completed",
              outputPath: req.outputPath,
              wallMs: 10,
              framesRendered: cancelled ? 1 : 30,
              totalFrames: 30,
              warnings: [],
              errorReason: cancelled ? "session_closed" : undefined,
            },
            workerPid: 3000,
            trackedChildPids: [],
            cleanupActions: [],
            survivingOrphans: 0,
          },
        };
      },
      cancel() {
        abortActive?.();
        return true;
      },
    };

    const queue = new RenderQueueManager({
      runner,
      isSessionValid: (sid) => sid === activeSessionId,
    });

    const jobA1 = queue.enqueue({ sessionId: "session-A", title: "A1", request: makeRequest("sa-1", dirA) });
    const jobA2 = queue.enqueue({ sessionId: "session-A", title: "A2", request: makeRequest("sa-2", dirA) });

    await sleep(15);
    // Simulate PreviewContainerManager closing/replacing session-A BEFORE purging dirA
    activeSessionId = "session-B";
    await queue.invalidateSession("session-A", "session_closed");
    purgeSessionDirectorySync(dirA);

    const [ra1, ra2] = await Promise.all([jobA1.completion, jobA2.completion]);
    assert.equal(ra1.status, "cancelled");
    assert.equal(ra2.status, "cancelled");
    assert.equal(ranJobs.some((j) => j.jobId === "sa-2"), false, "Queued job from invalidated session must never run");

    // Enqueueing against closed session-A or deleted dirA must reject synchronously
    assert.throws(
      () => queue.enqueue({ sessionId: "session-A", title: "Late", request: makeRequest("sa-3", dirA) }),
      (err) => err instanceof RenderQueueError && err.code === "SESSION_INVALIDATED"
    );
    assert.throws(
      () => queue.enqueue({ sessionId: "session-B", title: "MissingPath", request: makeRequest("sb-bad", dirA) }),
      (err) => err instanceof RenderQueueError && err.code === "STALE_SESSION_PATH"
    );

    // Enqueueing for valid session-B works cleanly and finishes before purge
    const jobB = queue.enqueue({ sessionId: "session-B", title: "B1", request: makeRequest("sb-1", dirB) });
    await queue.invalidateSession("session-B", "teardown");
    const rb = await jobB.completion;
    assert.equal(rb.status, "cancelled");
    purgeSessionDirectorySync(dirB);
  });
});
