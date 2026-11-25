import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = fileURLToPath(new URL("../", import.meta.url));
export const helperPath = join(
  projectRoot,
  ".local",
  "bin",
  process.platform === "win32" ? "coordinator.exe" : "coordinator",
);

export function goCommand(
  args: string[],
  moduleRoot = join(projectRoot, "services", "coordinator"),
): void {
  const result = spawnSync("go", args, {
    cwd: moduleRoot,
    stdio: "inherit",
    windowsHide: true,
    env: {
      ...process.env,
      GOPATH: join(projectRoot, ".cache", "go"),
      GOCACHE: join(projectRoot, ".cache", "go-build"),
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`go ${args[0]} failed (${result.status})`);
}

export function buildCoordinator(): void {
  mkdirSync(join(projectRoot, ".local", "bin"), { recursive: true });
  goCommand(["build", "-buildvcs=false", "-trimpath", "-o", helperPath, "."]);
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (
      args.length > 1 ||
      (args.length === 1 && !["--check", "--consensus"].includes(args[0]))
    )
      throw new Error(
        "Usage: node scripts/coordinator-build.ts [--check|--consensus]",
      );
    const check = args.length === 1;
    const race = args[0] === "--consensus";
    if (check) {
      goCommand(
        race
          ? ["test", "-race", "-count=1", "-timeout=8m", "./..."]
          : [
              "test",
              "-run",
              "^TestLocal|^TestRaft_AppendEntries_|^TestRaft_InstallSnapshot_",
              "./...",
            ],
        join(projectRoot, "third_party", "hashicorp-raft"),
      );
      goCommand(
        race
          ? ["test", "-race", "-count=1", "-timeout=2m", "./..."]
          : ["test", "./..."],
      );
      goCommand(["vet", "./..."]);
    }
    buildCoordinator();
    if (check) {
      const result = spawnSync(
        process.execPath,
        ["--test", "tests/coordinator-process.test.ts"],
        { cwd: projectRoot, stdio: "inherit", windowsHide: true },
      );
      if (result.error) throw result.error;
      if (result.status !== 0)
        throw new Error("Coordinator process test failed");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
