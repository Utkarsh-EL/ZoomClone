import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = fileURLToPath(new URL("../", import.meta.url));
export const helperPath = join(projectRoot, ".local", "bin", process.platform === "win32" ? "coordinator.exe" : "coordinator");

export function goCommand(args: string[]): void {
  const result = spawnSync("go", args, { cwd: join(projectRoot, "services", "coordinator"), stdio: "inherit", windowsHide: true,
    env: { ...process.env, GOPATH: join(projectRoot, ".cache", "go"), GOCACHE: join(projectRoot, ".cache", "go-build") } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`go ${args[0]} failed (${result.status})`);
}

export function buildCoordinator(): void {
  mkdirSync(join(projectRoot, ".local", "bin"), { recursive: true });
  goCommand(["build", "-buildvcs=false", "-trimpath", "-o", helperPath, "."]);
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) throw new Error("Usage: node scripts/coordinator-build.ts [--check]");
    if (args[0] === "--check") { goCommand(["test", "./..."]); goCommand(["vet", "./..."]); }
    buildCoordinator();
    if (args[0] === "--check") {
      const result = spawnSync(process.execPath, ["--test", "tests/coordinator-process.test.ts"], { cwd: projectRoot, stdio: "inherit", windowsHide: true });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error("Coordinator process test failed");
    }
  } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
