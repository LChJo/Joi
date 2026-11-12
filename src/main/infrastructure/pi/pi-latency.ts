import { randomUUID } from "node:crypto";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { emitRuntimeDiagnostic, type PiLatencyFields, type RuntimeDiagnostics } from "../../application/ports/runtime-diagnostics.js";

type Scope = Pick<PiLatencyFields,"workId" | "sourceId" | "purpose" | "runId">;
type Details = Pick<PiLatencyFields,"toolName" | "eventType" | "requestId">;
type Status = NonNullable<PiLatencyFields["status"]>;
type Stage = PiLatencyFields["stage"];

/** Timings contain lifecycle facts only; SDK call identifiers and payloads remain private. */
export class PiLatency {
  readonly #pending = new Map<string,ReturnType<PiLatency["start"]>>();
  readonly #callbacks = new Map<string,{ stage: "live_event" | "progress_check";eventType: string;count: number;total: number;max: number }>();
  constructor(private readonly diagnostics: RuntimeDiagnostics | undefined,private readonly scope: Scope) {}

  start(stage: Stage,details: Details = {}) {
    const spanId = this.diagnostics === undefined ? "" : randomUUID(),started = performance.now();
    const emit = (state: PiLatencyFields["state"],extra: Partial<Pick<PiLatencyFields,"status" | "sdkDurationMs">> = {}) => {
      emitRuntimeDiagnostic(this.diagnostics,"joi.pi.latency",{ ...this.scope,...details,stage,state,spanId,
        ...(state === "started" ? {} : { durationMs: Math.max(0,performance.now() - started) }),...extra });
    };
    emit("started");
    let finished = false,first = false,delta = false;
    return {
      id: spanId,
      firstEvent: (state: "first_event" | "first_delta" = "first_event") => {
        if (state === "first_event" && !first) { first = true;emit(state); }
        if (state === "first_delta" && !delta) { delta = true;emit(state); }
      },
      finish: (status: Status = "completed",sdkDurationMs?: number) => {
        if (finished) return;
        finished = true;
        emit("completed",{ status,...(sdkDurationMs !== undefined && Number.isFinite(sdkDurationMs) && sdkDurationMs >= 0 ? { sdkDurationMs } : {}) });
      },
    };
  }

  async measure<T>(stage: Stage,run: () => T | Promise<T>,details: Details = {}): Promise<T> {
    const span = this.start(stage,details);
    try { const result = await run();span.finish();return result; }
    catch (error) { span.finish(error instanceof Error && error.name === "AbortError" ? "canceled" : "failed");throw error; }
  }

  async callback<T>(stage: "live_event" | "progress_check",eventType: string,run: () => T | Promise<T>): Promise<T> {
    const started = performance.now();
    try { return await run(); }
    finally {
      const durationMs = Math.max(0,performance.now() - started),key = `${stage}:${eventType}`;
      const current = this.#callbacks.get(key) ?? { stage,eventType,count: 0,total: 0,max: 0 };
      current.count++;current.total += durationMs;current.max = Math.max(current.max,durationMs);this.#callbacks.set(key,current);
      if (durationMs >= 100) emitRuntimeDiagnostic(this.diagnostics,"joi.pi.latency",{ ...this.scope,stage,eventType,state: "slow",spanId: randomUUID(),durationMs });
    }
  }

  event(event: AgentEvent): void {
    if (event.type === "tool_execution_start") {
      this.#pending.set(event.toolCallId,this.start("tool",{ toolName: event.toolName }));
    } else if (event.type === "tool_execution_end") {
      this.#pending.get(event.toolCallId)?.finish(event.isError ? "failed" : "completed",event.durationMs);
      this.#pending.delete(event.toolCallId);
    }
  }

  finish(status: Status): void {
    for (const span of this.#pending.values()) span.finish(status === "completed" ? "failed" : status);
    this.#pending.clear();
    for (const entry of this.#callbacks.values()) emitRuntimeDiagnostic(this.diagnostics,"joi.pi.latency",{
      ...this.scope,stage: entry.stage,eventType: entry.eventType,state: "summary",spanId: randomUUID(),count: entry.count,durationMs: entry.total,maxMs: entry.max,
    });
    this.#callbacks.clear();
  }
}
