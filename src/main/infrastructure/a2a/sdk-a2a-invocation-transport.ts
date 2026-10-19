import type { Transport } from "@a2a-js/sdk/client";
import { JsonRpcTransport, RestTransport } from "@a2a-js/sdk/client";
import type { Artifact, Message, MessageSendParams, Part, Task, TaskArtifactUpdateEvent, TaskStatusUpdateEvent } from "@a2a-js/sdk";

import type {
  A2aInvocationOutput,
  A2aInvocationRequest,
  A2aInvocationTransport,
  A2aRemoteEvent,
  A2aRemoteState,
  A2aTransportConfig,
} from "../../application/ports/a2a-ports.js";
import { DomainError } from "../../domain/errors.js";
import { RUNTIME_EXTENSION_URI } from "../../../shared/product.js";
import type { UsageRecorder } from "../../application/ports/usage.js";
import type { OutboundNetworkPolicy } from "./outbound-network-policy.js";
import { beginUsage, unknownUsageObservation, usageFailureStatus } from "../usage/sdk-usage.js";

export class A2aTransportHttpError extends Error {
  constructor(public readonly status: 429 | 503, public readonly retryAfter: string | null) {
    super("Agent returned a retryable response.");
    this.name = "A2aTransportHttpError";
  }
}

type StreamEvent = Message | Task | TaskArtifactUpdateEvent | TaskStatusUpdateEvent;

function mapState(state: Task["status"]["state"]): A2aRemoteState {
  return state;
}

function mapTask(task: Task): A2aRemoteEvent {
  const outputs = [
    ...(task.status.message === undefined ? [] : [outputFromMessage(task.status.message)]),
    ...(task.artifacts === undefined ? [] : task.artifacts.map(outputFromArtifact)),
  ];
  return {
    contextId: task.contextId,
    kind: "task",
    ...(outputs.length === 0 ? {} : { output: mergeOutputs(outputs) }),
    state: mapState(task.status.state),
    taskId: task.id,
  };
}

function extensionUri(extensions: string[] | undefined): string | undefined {
  return extensions?.includes(RUNTIME_EXTENSION_URI) === true ? RUNTIME_EXTENSION_URI : undefined;
}

function outputFromMessage(message: Message): A2aInvocationOutput {
  const uri = extensionUri(message.extensions);
  return {
    artifacts: [],
    parts: message.parts.map((part) => part.kind === "data"
      ? { data: part.data, ...(uri === undefined ? {} : { extensionUri: uri }), kind: "data" }
      : { data: part.kind === "text" ? part.text : null, kind: part.kind }),
  };
}

function outputFromArtifact(artifact: Artifact): A2aInvocationOutput {
  const text = artifact.parts.filter((part) => part.kind === "text").map((part) => part.text).join("");
  return {
    artifacts: text === "" ? [] : [{ name: artifact.name ?? artifact.artifactId, text }],
    parts: artifact.parts.filter((part) => part.kind === "data").map((part) => ({ data: part.data, kind: "data" })),
  };
}

function mergeOutputs(outputs: A2aInvocationOutput[]): A2aInvocationOutput {
  return {
    artifacts: outputs.flatMap((output) => output.artifacts),
    parts: outputs.flatMap((output) => output.parts),
  };
}

function firstFile(event: TaskArtifactUpdateEvent) {
  const part = event.artifact.parts.find((candidate) => candidate.kind === "file");
  if (part?.kind !== "file") return {};
  const file = part.file;
  if ("uri" in file) {
    return {
      ...(file.mimeType === undefined ? {} : { mimeType: file.mimeType }),
      ...(file.name === undefined ? {} : { filename: file.name }),
      url: file.uri,
    };
  }
  return {
    ...(file.mimeType === undefined ? {} : { mimeType: file.mimeType }),
    ...(file.name === undefined ? {} : { filename: file.name }),
    size: Buffer.from(file.bytes, "base64").byteLength,
  };
}

function mapEvent(event: StreamEvent): A2aRemoteEvent {
  switch (event.kind) {
    case "task": return mapTask(event);
    case "message": return { contextId: event.contextId ?? "", kind: "message", output: outputFromMessage(event) };
    case "status-update":
      return {
        contextId: event.contextId,
        final: event.final,
        kind: "status",
        ...(event.status.message === undefined ? {} : { output: outputFromMessage(event.status.message) }),
        state: mapState(event.status.state),
        taskId: event.taskId,
      };
    case "artifact-update":
      return {
        artifactId: event.artifact.artifactId,
        contextId: event.contextId,
        kind: "artifact",
        output: outputFromArtifact(event.artifact),
        taskId: event.taskId,
        ...firstFile(event),
      };
  }
}

function toPart(part: A2aInvocationRequest["parts"][number]): Part {
  switch (part.kind) {
    case "text": return { kind: "text", text: part.text };
    case "data": return { data: part.data, kind: "data" };
    case "file": return {
      file: {
        bytes: part.bytes,
        ...(part.mimeType === undefined ? {} : { mimeType: part.mimeType }),
        ...(part.name === undefined ? {} : { name: part.name }),
      },
      kind: "file",
    };
  }
}

export class SdkA2aInvocationTransport implements A2aInvocationTransport {
  constructor(private readonly dependencies: { fetchImpl?: typeof fetch; policy: OutboundNetworkPolicy; usage?: UsageRecorder }) {}

  async *sendStream(input: { config: A2aTransportConfig; request: A2aInvocationRequest; signal?: AbortSignal; token: string }): AsyncIterable<A2aRemoteEvent> {
    const scope = input.request.parts.find((part) => part.kind === "data" && part.data.sourceBoundary === "joi-work");
    const usageContext = { engine: "a2a" as const, purpose: "partner" as const, sourceId: input.config.agentConnectionId, sourceName: "A2A",
      ...(scope?.kind === "data" && typeof scope.data.workbenchId === "string" ? { workbenchId: scope.data.workbenchId } : {}),
      ...(scope?.kind === "data" && typeof scope.data.workId === "string" ? { workId: scope.data.workId } : {}),
    };
    const usage = beginUsage(this.dependencies.usage, usageContext);
    usage.record(unknownUsageObservation(usageContext));
    let settled = false;
    try {
      const transport = this.transport(input.config);
      const request: MessageSendParams = {
        message: {
          ...(input.request.contextId === undefined ? {} : { contextId: input.request.contextId }),
          ...(input.request.extensions === undefined ? {} : { extensions: input.request.extensions }),
          kind: "message",
          messageId: input.request.messageId,
          parts: input.request.parts.map(toPart),
          role: "user",
        },
      };
      const timeout = AbortSignal.timeout(5 * 60_000);
      const signal = input.signal === undefined ? timeout : AbortSignal.any([input.signal, timeout]);
      let outcome: "completed" | "failed" | "canceled" = "completed";
      for await (const event of transport.sendMessageStream(request, { signal })) {
        const mapped = mapEvent(event);
        if (mapped.kind === "task" || mapped.kind === "status") {
          if (mapped.state === "failed" || mapped.state === "rejected") outcome = "failed";
          else if (mapped.state === "canceled") outcome = "canceled";
        }
        yield mapped;
      }
      settled = true;
      usage.finish(outcome);
    } catch (error) {
      settled = true;
      usage.finish(usageFailureStatus(input.signal));
      throw error;
    } finally {
      if (!settled) usage.finish(input.signal?.aborted === true ? "canceled" : "interrupted");
    }
  }

  async getTask(input: { config: A2aTransportConfig; taskId: string }): Promise<A2aRemoteEvent> {
    return mapTask(await this.transport(input.config).getTask({ id: input.taskId }, { signal: AbortSignal.timeout(30_000) }));
  }

  async cancelTask(input: { config: A2aTransportConfig; taskId: string }): Promise<A2aRemoteEvent> {
    return mapTask(await this.transport(input.config).cancelTask({ id: input.taskId }, { signal: AbortSignal.timeout(30_000) }));
  }

  async *resubscribe(input: { config: A2aTransportConfig; taskId: string }): AsyncIterable<A2aRemoteEvent> {
    for await (const event of this.transport(input.config).resubscribeTask({ id: input.taskId }, { signal: AbortSignal.timeout(5 * 60_000) })) {
      yield mapEvent(event);
    }
  }

  private transport(config: A2aTransportConfig): Transport {
    const fetchImpl = this.authorizedFetch(config);
    return config.transport === "JSONRPC"
      ? new JsonRpcTransport({ endpoint: config.rpcUrl, fetchImpl })
      : new RestTransport({ endpoint: config.rpcUrl, fetchImpl });
  }

  private authorizedFetch(config: A2aTransportConfig): typeof fetch {
    return async (resource, init) => {
      const initialUrl = resource instanceof Request ? resource.url : resource.toString();
      const headers = new Headers(resource instanceof Request ? resource.headers : undefined);
      new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
      headers.set("authorization", `Bearer ${config.token}`);
      const fetchImpl = this.dependencies.fetchImpl ?? fetch;
      let current = initialUrl;
      for (let redirects = 0; redirects <= 3; redirects += 1) {
        const validated = await this.dependencies.policy.validate(current);
        if (validated.origin !== config.origin) throw new DomainError("agent_reconfirm_required", "Agent request Origin changed after confirmation.");
        const response = await fetchImpl(validated.url, {
          ...init,
          headers,
          redirect: "manual",
          signal: init?.signal ?? AbortSignal.timeout(30_000),
        });
        if (response.status === 429 || response.status === 503) {
          throw new A2aTransportHttpError(response.status, response.headers.get("retry-after"));
        }
        if (response.status < 300 || response.status >= 400) return response;
        const location = response.headers.get("location");
        if (location === null) throw new DomainError("agent_unavailable", "Agent redirect is missing Location.");
        current = (await this.dependencies.policy.validateRedirect({ bearerOrigin: config.origin, from: current, location })).url;
      }
      throw new DomainError("agent_unavailable", "Agent redirect limit exceeded.");
    };
  }
}
