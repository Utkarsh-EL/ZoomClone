import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { projectRoot } from "./coordinator-build.ts";

/** Owns only this Compose project. Shutdown deliberately retains the volume. */
export class StorageLab {
  readonly clusterId = randomUUID();
  readonly project = "zoom-storage-" + randomUUID().slice(0, 8);
  readonly root = join(projectRoot, ".local", "storage-labs", this.project);
  readonly password = randomBytes(32).toString("hex");
  port = 0;
  get url(): string { return `postgresql://zoom_admin:${this.password}@127.0.0.1:${this.port}/zoomlab`; }
  docker(args: string[]): string {
    const result = spawnSync("docker", args, { cwd: projectRoot, encoding: "utf8", windowsHide: true, maxBuffer: 4*1024*1024 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Docker operation failed: ${result.stderr}`);
    return result.stdout.trim();
  }
  compose(args: string[]): string {
    return this.docker(["compose", "--project-name", this.project, "--env-file", join(this.root, "lab.env"), "-f", join(projectRoot, "compose.yaml"), ...args]);
  }
  async start(): Promise<void> {
    const reservation = createServer();
    await new Promise<void>((resolve, reject) => { reservation.once("error", reject); reservation.listen(0, "127.0.0.1", resolve); });
    const address = reservation.address();
    if (!address || typeof address === "string") throw new Error("No PostgreSQL port");
    this.port = address.port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    await mkdir(this.root, { recursive: true });
    await writeFile(join(this.root, "lab.env"), `ZOOM_PG_PASSWORD=${this.password}\nZOOM_PG_PORT=${this.port}\nCOMPOSE_PROJECT_NAME=${this.project}\n`, { flag: "wx", mode: 0o600 });
    await writeFile(join(this.root, "lab.json"), JSON.stringify({ project: this.project, clusterId: this.clusterId, port: this.port }), { flag: "wx" });
    this.compose(["up", "--detach", "--wait", "--wait-timeout", "60"]);
  }
  stop(): void { this.compose(["down", "--timeout", "5"]); }
}
