// Minimal isolated test stub worker for verifying RenderWorkerHost heartbeat hang watchdog.
import { spawn } from "node:child_process";

let port = null;
let spawnedHelper = null;

process.parentPort.on("message", (event) => {
  const data = event?.data;
  if (data?.type === "init" && event.ports?.[0]) {
    port = event.ports[0];
    port.on("message", (ev) => {
      const msg = ev.data;
      if (msg?.type === "ping") {
        port.postMessage({ type: "pong", seq: msg.seq, pid: process.pid, receivedAtMs: Date.now() });
      } else if (msg?.type === "startRender") {
        // Spawn a harmless long-sleeping node child to test process-tree cleanup on watchdog kill
        spawnedHelper = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
          stdio: "ignore",
        });
        if (spawnedHelper.pid) {
          port.postMessage({
            type: "childProcessTracked",
            jobId: msg.request.jobId,
            childPid: spawnedHelper.pid,
            command: "hang-helper",
          });
        }
        // Intentionally freeze JS event loop so pings cannot be answered
        setTimeout(() => {
          while (true) {}
        }, 50);
      }
    });
    port.start();
    port.postMessage({
      type: "ready",
      pid: process.pid,
      nodeVersion: process.version,
      electronVersion: process.versions.electron || null,
      pinnedRuntime: {
        hyperframesEngineVersion: "0.9.93",
        hyperframesProducerVersion: "0.9.93",
        electronVersion: "45.4.1",
        chromeHeadlessShellVersion: "158.0.8127.36",
      },
    });
  }
});
