import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { projectRoot } from "./coordinator-build.ts";
import { StorageLab } from "./storage-lab.ts";

const lab = new StorageLab();
let started = false;
try {
  await lab.start();
  started = true;
  console.log(`PostgreSQL evidence lab: ${lab.project}`);
  const env = {
    ...process.env,
    ZOOM_STORAGE_ADMIN_URL: lab.url,
    ZOOM_STORAGE_CLUSTER_ID: lab.clusterId,
    ZOOM_STORAGE_LAB_ROOT: lab.root,
    ZOOM_STORAGE_RUNTIME_PASSWORD: randomBytes(32).toString("hex"),
    ZOOM_STORAGE_INSPECTOR_PASSWORD: randomBytes(32).toString("hex"),
  };
  for (const file of [
    "tests/storage.test.ts",
    "tests/storage-faults.test.ts",
    ...(process.argv.includes("--recovery") ? ["tests/recovery.test.ts"] : []),
    ...(process.argv.includes("--runtimes") ? ["tests/runtime-process.test.ts"] : []),
  ]) {
    const child = spawn(process.execPath, ["--test", file], {
      cwd: projectRoot,
      stdio: "inherit",
      windowsHide: true,
      env,
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    if (code !== 0) {
      process.exitCode = code ?? 1;
      break;
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  if (started) lab.stop();
}
