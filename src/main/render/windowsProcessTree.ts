import { spawnSync } from "node:child_process";

export interface ProcessSnapshot {
  ProcessId: number;
  ParentProcessId: number;
  Name: string;
  CommandLine?: string | null;
}

export interface KillActionRecord {
  target: "worker_tree" | "tracked_descendant" | "straggler_tree";
  pid: number;
  status: number | null;
  stdout: string;
  stderr: string;
}

const TARGET_MEDIA_PROCESS_NAMES = new Set([
  "chrome-headless-shell.exe",
  "chrome.exe",
  "ffmpeg.exe",
]);

export function queryMediaAndWorkerProcesses(): ProcessSnapshot[] {
  if (process.platform !== "win32") return [];
  const psScript = `
    $procs = Get-CimInstance Win32_Process | Where-Object {
      $_.Name -in @('chrome-headless-shell.exe','chrome.exe','ffmpeg.exe','electron.exe')
    } | Select-Object ProcessId, ParentProcessId, Name, CommandLine
    $procs | ConvertTo-Json -Compress
  `;
  const res = spawnSync("powershell.exe", ["-NoProfile", "-Command", psScript], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.status !== 0 || !res.stdout.trim()) return [];
  try {
    const parsed = JSON.parse(res.stdout.trim()) as ProcessSnapshot | ProcessSnapshot[];
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

export function findWorkerDescendants(
  allProcs: ProcessSnapshot[],
  workerPid: number,
  stagePattern?: string
): ProcessSnapshot[] {
  const byParent = new Map<number, ProcessSnapshot[]>();
  for (const p of allProcs) {
    const arr = byParent.get(p.ParentProcessId);
    if (arr) arr.push(p);
    else byParent.set(p.ParentProcessId, [p]);
  }

  const matched = new Map<number, ProcessSnapshot>();
  const queue: number[] = [workerPid];
  const visited = new Set<number>([workerPid]);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const child of byParent.get(cur) ?? []) {
      matched.set(child.ProcessId, child);
      if (!visited.has(child.ProcessId)) {
        visited.add(child.ProcessId);
        queue.push(child.ProcessId);
      }
    }
  }

  const normPattern = stagePattern ? stagePattern.toLowerCase() : null;
  for (const p of allProcs) {
    if (p.ProcessId === workerPid) continue;
    if (!TARGET_MEDIA_PROCESS_NAMES.has(p.Name)) continue;
    if (p.ParentProcessId === workerPid) {
      matched.set(p.ProcessId, p);
      continue;
    }
    const cmd = (p.CommandLine || "").toLowerCase();
    if (normPattern && cmd.includes(normPattern)) {
      matched.set(p.ProcessId, p);
    }
  }

  return Array.from(matched.values());
}

function taskkillTree(pid: number): Omit<KillActionRecord, "target"> {
  if (process.platform !== "win32") {
    try {
      process.kill(pid, "SIGKILL");
      return { pid, status: 0, stdout: "SIGKILL", stderr: "" };
    } catch (err) {
      return { pid, status: 1, stdout: "", stderr: String(err) };
    }
  }

  const res = spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
    encoding: "utf8",
  });
  return {
    pid,
    status: res.status,
    stdout: (res.stdout || "").trim(),
    stderr: (res.stderr || "").trim(),
  };
}

/**
 * Terminates the isolated worker PID tree AND explicitly sweeps any tracked or
 * reparented Chrome / FFmpeg child processes belonging to the render stage.
 */
export function terminateWindowsProcessTree(
  workerPid: number | null,
  trackedChildPids: Iterable<number>,
  stagePattern?: string
): KillActionRecord[] {
  const actions: KillActionRecord[] = [];
  const allBefore = queryMediaAndWorkerProcesses();
  const discovered = workerPid
    ? findWorkerDescendants(allBefore, workerPid, stagePattern)
    : [];

  if (workerPid !== null) {
    actions.push({ target: "worker_tree", ...taskkillTree(workerPid) });
  }

  const sweepSet = new Set<number>(trackedChildPids);
  for (const d of discovered) {
    if (TARGET_MEDIA_PROCESS_NAMES.has(d.Name)) {
      sweepSet.add(d.ProcessId);
    }
  }

  for (const childPid of sweepSet) {
    actions.push({ target: "tracked_descendant", ...taskkillTree(childPid) });
  }

  // Final sweep in case a descendant spawned a child right as worker died
  const afterProcs = queryMediaAndWorkerProcesses();
  const stragglers = findWorkerDescendants(afterProcs, workerPid ?? -1, stagePattern).filter(
    (p) => TARGET_MEDIA_PROCESS_NAMES.has(p.Name) || sweepSet.has(p.ProcessId)
  );
  for (const s of stragglers) {
    actions.push({ target: "straggler_tree", ...taskkillTree(s.ProcessId) });
  }

  return actions;
}

export function findSurvivingMediaProcesses(
  baselinePids: ReadonlySet<number>,
  trackedChildPids: ReadonlySet<number>,
  workerPid: number | null,
  stagePattern?: string
): ProcessSnapshot[] {
  const all = queryMediaAndWorkerProcesses();
  const descendants = findWorkerDescendants(all, workerPid ?? -1, stagePattern);
  const found = new Map<number, ProcessSnapshot>();

  for (const d of descendants) {
    if (TARGET_MEDIA_PROCESS_NAMES.has(d.Name)) {
      found.set(d.ProcessId, d);
    }
  }
  for (const p of all) {
    if (!TARGET_MEDIA_PROCESS_NAMES.has(p.Name)) continue;
    if (baselinePids.has(p.ProcessId)) continue;
    if (trackedChildPids.has(p.ProcessId) || (workerPid !== null && p.ParentProcessId === workerPid)) {
      found.set(p.ProcessId, p);
    }
  }

  return Array.from(found.values());
}
