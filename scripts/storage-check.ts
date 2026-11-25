import { spawn } from "node:child_process";
import { projectRoot } from "./coordinator-build.ts";
import { StorageLab } from "./storage-lab.ts";

const lab = new StorageLab();
let started = false;
try {
  await lab.start(); started = true;
  console.log(`PostgreSQL evidence lab: ${lab.project}`);
  const child = spawn(process.execPath, ["--test", "tests/storage.test.ts"], { cwd: projectRoot, stdio: "inherit", windowsHide: true,
    env: { ...process.env, ZOOM_STORAGE_ADMIN_URL: lab.url, ZOOM_STORAGE_CLUSTER_ID: lab.clusterId, ZOOM_STORAGE_LAB_ROOT: lab.root } });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  process.exitCode = code ?? 1;
} catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
finally { if (started) lab.stop(); }
