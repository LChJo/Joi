import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

interface MarkerPayload {
  instanceId: string;
  pid: number;
  startedAt: string;
  version: 1;
}

export interface StartupEvidence {
  previousInstanceId?: string;
  previousStartedAt?: string;
  uncleanShutdown: boolean;
}

export class RuntimeMarker {
  private readonly markerPath: string;
  private started = false;

  constructor(private readonly userDataDirectory: string) {
    this.markerPath = path.join(userDataDirectory, "runtime.active.json");
  }

  async start(now: Date): Promise<StartupEvidence> {
    await mkdir(this.userDataDirectory, { recursive: true });
    let previous: MarkerPayload | null = null;
    try {
      const parsed: unknown = JSON.parse(await readFile(this.markerPath, "utf8"));
      if (parsed !== null && typeof parsed === "object") previous = parsed as MarkerPayload;
    } catch (error) {
      const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    const current: MarkerPayload = { instanceId: randomUUID(), pid: process.pid, startedAt: now.toISOString(), version: 1 };
    const temporary = `${this.markerPath}.${String(process.pid)}.tmp`;
    await writeFile(temporary, JSON.stringify(current), { encoding: "utf8", flag: "wx" });
    await rm(this.markerPath, { force: true });
    await rename(temporary, this.markerPath);
    this.started = true;
    return {
      ...(typeof previous?.instanceId === "string" ? { previousInstanceId: previous.instanceId } : {}),
      ...(typeof previous?.startedAt === "string" ? { previousStartedAt: previous.startedAt } : {}),
      uncleanShutdown: previous !== null,
    };
  }

  async clean(): Promise<void> {
    if (!this.started) return;
    await rm(this.markerPath, { force: true });
    this.started = false;
  }
}
