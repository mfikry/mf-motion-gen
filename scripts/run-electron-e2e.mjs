import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const targetMap = {
  sprint1: "sprint1Verification.mjs",
  sprint2: "sprint2PreviewVerification.mjs",
  sprint3: "sprint3WorkbenchVerification.mjs",
  sprint4: "sprint4ImportAndAssetTreeVerification.mjs",
  sprint5: "sprint5StaticAnalyzerAndDiffVerification.mjs",
};
const target = targetMap[process.argv[2]] || "sprint1Verification.mjs";
const electronExe = path.join(repoRoot, "node_modules", "electron", "dist", "electron.exe");
const mainJs = path.join(repoRoot, "dist", "main", "index.js");
const e2eScript = path.join(repoRoot, "tests", "e2e", target);

const cleanEnv = { ...process.env };
delete cleanEnv.ELECTRON_RUN_AS_NODE;
cleanEnv.MF_E2E_SCRIPT = e2eScript;
cleanEnv.MF_HEADLESS_WINDOW = "1";

const res = spawnSync(electronExe, [mainJs], {
  env: cleanEnv,
  stdio: "inherit",
  timeout: 180000,
});

process.exit(res.status ?? 1);
