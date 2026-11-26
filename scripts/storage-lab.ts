import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { projectRoot } from "./coordinator-build.ts";
import { UUID_PATTERN } from "../coordination/wire.ts";
export type DockerRunner = (args: string[], env?: Record<string, string>) => Promise<string>;

/** Owns only this Compose project. Shutdown deliberately retains the volume. */
export class StorageLab {
  readonly clusterId: string;
  readonly project: string;
  readonly root: string;
  readonly password: string;
  private readonly resuming: boolean;
  port = 0;
  constructor(existing?: {
    clusterId: string;
    project: string;
    root: string;
    password: string;
    port: number;
  }) {
    this.clusterId = existing?.clusterId ?? randomUUID();
    this.project =
      existing?.project ?? "zoom-storage-" + randomUUID().slice(0, 8);
    this.root =
      existing?.root ??
      join(projectRoot, ".local", "storage-labs", this.project);
    this.password = existing?.password ?? randomBytes(32).toString("hex");
    this.port = existing?.port ?? 0;
    this.resuming = !!existing;
  }
  static async resume(root: string): Promise<StorageLab> {
    const record = JSON.parse(await readFile(join(root, "lab.json"), "utf8"));
    if (
      !/^zoom-storage-[a-f0-9]{8}$/.test(record.project) ||
      !UUID_PATTERN.test(record.clusterId) ||
      resolve(root) !==
        resolve(projectRoot, ".local", "storage-labs", record.project) ||
      !Number.isInteger(record.port) ||
      record.port < 1 ||
      record.port > 65535
    )
      throw new Error("Invalid owned storage lab manifest");
    const env = await readFile(join(root, "lab.env"), "utf8");
    const password = /^ZOOM_PG_PASSWORD=([a-f0-9]{64})$/m.exec(env)?.[1];
    if (!password) throw new Error("Storage credential missing");
    return new StorageLab({ ...record, root: resolve(root), password });
  }
  get url(): string {
    return `postgresql://zoom_admin:${this.password}@127.0.0.1:${this.port}/zoomlab`;
  }
  docker(args: string[], env?: Record<string, string>): string {
    const result = spawnSync("docker", args, {
      cwd: projectRoot,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, ...env },
    });
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(`Docker operation failed: ${result.stderr}`);
    return result.stdout.trim();
  }
  compose(args: string[]): string {
    return this.docker(this.composeArgs(args));
  }
  private composeArgs(args: string[]): string[] {
    return [
      "compose",
      "--project-name",
      this.project,
      "--env-file",
      join(this.root, "lab.env"),
      "-f",
      join(projectRoot, "compose.yaml"),
      ...args,
    ];
  }
  async start(options: { run?: DockerRunner } = {}): Promise<void> {
    const docker: DockerRunner = options.run ?? (async (args, env) => this.docker(args, env));
    const compose = async (args: string[]) => options.run ? docker(this.composeArgs(args)) : this.compose(args);
    if (this.resuming) {
      await docker(["volume", "inspect", this.project + "_meeting-data"]);
      await compose(["up", "--detach", "--wait", "--wait-timeout", "60"]);
      return;
    }
    const reservation = createServer();
    await new Promise<void>((resolve, reject) => {
      reservation.once("error", reject);
      reservation.listen(0, "127.0.0.1", resolve);
    });
    const address = reservation.address();
    if (!address || typeof address === "string")
      throw new Error("No PostgreSQL port");
    this.port = address.port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    await mkdir(this.root, { recursive: true });
    await writeFile(
      join(this.root, "lab.env"),
      `ZOOM_PG_PASSWORD=${this.password}\nZOOM_PG_PORT=${this.port}\nCOMPOSE_PROJECT_NAME=${this.project}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await writeFile(
      join(this.root, "lab.json"),
      JSON.stringify({
        project: this.project,
        clusterId: this.clusterId,
        port: this.port,
      }),
      { flag: "wx" },
    );
    try {
      await compose(["up", "--detach", "--wait", "--wait-timeout", "60"]);
    } catch (error) {
      try {
        if (options.run) await this.stopAsync(options.run); else this.stop();
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          "Storage startup and owned-resource cleanup both failed",
        );
      }
      throw error;
    }
  }
  startTransactionHolder(meetingId: string): {
    containerId: string;
    applicationName: string;
  } {
    if (!UUID_PATTERN.test(meetingId)) throw new Error("Meeting UUID required");
    const applicationName = "zoom-paused-" + randomUUID().slice(0, 8);
    const image = this.compose(["config", "--images"]).split("\n")[0];
    const source = String.raw`psql -h postgres -U zoom_admin -d zoomlab -v ON_ERROR_STOP=1 -v meeting_id="$ZOOM_PAUSE_MEETING" <<'SQL'
BEGIN;
SET LOCAL idle_in_transaction_session_timeout='1200ms';
SELECT meeting_id FROM zoom.meeting_fences WHERE meeting_id=:'meeting_id'::uuid FOR UPDATE;
UPDATE zoom.meeting_fences SET seq=991 WHERE meeting_id=:'meeting_id'::uuid;
\! sleep 60
ROLLBACK;
SQL`;
    const containerId = this.docker(
      [
        "run",
        "--detach",
        "--name",
        this.project + "-holder-" + applicationName.slice(-8),
        "--label",
        "org.zoomclone.lab=" + this.project,
        "--label",
        "org.zoomclone.kind=transaction-holder",
        "--network",
        this.project + "_default",
        "--env",
        "PGPASSWORD",
        "--env",
        "PGAPPNAME",
        "--env",
        "ZOOM_PAUSE_MEETING",
        "--entrypoint",
        "sh",
        image,
        "-c",
        source,
      ],
      {
        PGPASSWORD: this.password,
        PGAPPNAME: applicationName,
        ZOOM_PAUSE_MEETING: meetingId,
      },
    );
    return { containerId, applicationName };
  }
  stop(): void {
    const holders = this.docker([
      "ps",
      "--all",
      "--quiet",
      "--filter",
      "label=org.zoomclone.lab=" + this.project,
      "--filter",
      "label=org.zoomclone.kind=transaction-holder",
    ])
      .split(/\s+/)
      .filter(Boolean);
    if (holders.length) {
      if (!holders.every((id) => /^[a-f0-9]{12,64}$/.test(id)))
        throw new Error("Unexpected container ID");
      this.docker(["rm", "--force", ...holders]);
    }
    this.compose(["down", "--timeout", "5"]);
  }
  /** Async bounded runner lets a supervisor continue serving status/stop while
   * Docker is busy. The ordinary evidence-runner interface stays unchanged. */
  async stopAsync(run: DockerRunner): Promise<void> {
    const holders = (await run(["ps", "--all", "--quiet", "--filter", "label=org.zoomclone.lab=" + this.project,
      "--filter", "label=org.zoomclone.kind=transaction-holder"])).split(/\s+/).filter(Boolean);
    if (holders.length) {
      if (!holders.every(id => /^[a-f0-9]{12,64}$/.test(id))) throw new Error("Unexpected container ID");
      await run(["rm", "--force", ...holders]);
    }
    await run(this.composeArgs(["down", "--timeout", "5"]));
  }
}

if (import.meta.main) {
  try {
    const [operation, root] = process.argv.slice(2);
    if (operation === "new" && !root) {
      const lab = new StorageLab();
      await lab.start();
      console.log(lab.root);
    } else if (["resume", "stop"].includes(operation) && root) {
      const lab = await StorageLab.resume(root);
      if (operation === "resume") await lab.start();
      else lab.stop();
      console.log(`${operation}: ${lab.project}`);
    } else
      throw new Error(
        "Usage: node scripts/storage-lab.ts new | resume <lab-directory> | stop <lab-directory>",
      );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
