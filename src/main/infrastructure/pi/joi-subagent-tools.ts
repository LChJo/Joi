import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { registerExternalJobProvider,type ExternalJobProvider,type ExternalJobState } from "pi-subagents/external-job-provider";
import { registerSubagentCapabilityCeiling } from "pi-subagents/capability-ceiling";
import type { ConversationChild,ConversationChildInput,ConversationSubagentPort } from "../../application/ports/conversation-subagents.js";
import { DomainError } from "../../domain/errors.js";
import { summaryCandidateKey } from "./pi-compaction.js";

function state(status: ConversationChild["status"]): ExternalJobState {
  return status === "QUEUED" ? "queued" : status === "RUNNING" ? "running" : status === "COMPLETED" ? "completed" : status === "CANCELED" ? "stopped" : "failed";
}

/** The bundled package's external-job protocol runs through Joi's durable, permission-bound host. */
export function createJoiSubagentTools(port: ConversationSubagentPort,input: Omit<ConversationChildInput,"callId" | "task">,allowedTools: string[],signal?: AbortSignal) {
  const parent = input.parentTurnId;
  const ceiling = registerSubagentCapabilityCeiling({ sessionId: parent,source: "joi-host",ceiling: { allowedTools,denyExtensions: true } });
  const own = async (id: string) => {
    const child = (await port.list(parent)).find(child => child.childId === id);
    if (child === undefined) throw new DomainError("subagent_not_found","Child does not belong to this conversation turn.");
    return child;
  };
  const provider: ExternalJobProvider = {
    name: `joi-${parent}`,
    start: async job => { const child = await port.start({ ...input,callId: job.runId,task: job.prompt });return { providerJobId: child.childId,state: state(child.status) }; },
    status: async id => ({ providerJobId: id,state: state((await own(id)).status) }),
    result: async id => { const child = await own(id);return { providerJobId: id,state: state(child.status),...(child.body === undefined ? {} : { output: child.body }) }; },
    reattach: async id => ({ providerJobId: id,state: state((await own(id)).status) }),
  };
  const unregister = registerExternalJobProvider(provider);
  const abort = () => { void port.cancel(parent); };
  signal?.addEventListener("abort",abort,{ once: true });
  const tools: AgentTool[] = [
    { name: "subagent",label: "Delegate",description: "Start a Pi child with your current model, workspace and permission ceiling. Children are durable; wait for their results before concluding. Do not replay an interrupted child automatically.",
      parameters: Type.Object({ task: Type.String({ minLength: 1,maxLength: 64000 }) }),execute: async (id,raw) => {
        const task = (raw as { task: string }).task;
        const child = await provider.start({ prompt: task,promptDigest: summaryCandidateKey(task),cwd: ".",runId: id,stepIndex: 0,agent: "joi-worker",options: {} });
        return { content: [{ type: "text",text: JSON.stringify(child) }],details: {} };
      } },
    { name: "subagent_status",label: "Child status",description: "Read child status and full completed results for this parent turn.",parameters: Type.Object({ childId: Type.Optional(Type.String()) }),
      execute: async (_id,raw) => {
        const id = (raw as { childId?: string }).childId;
        const result = id === undefined ? await port.list(parent) : [await own(id)];
        return { content: [{ type: "text",text: JSON.stringify(result.map(({ childId,status,body }) => ({ childId,status,body }))) }],details: {} };
      } },
    { name: "subagent_cancel",label: "Cancel child",description: "Cancel a child owned by this parent turn.",parameters: Type.Object({ childId: Type.String() }),execute: async (_id,raw) => {
      const id = (raw as { childId: string }).childId;await own(id);await port.cancel(parent,id);
      return { content: [{ type: "text",text: "Child cancellation requested. Wait for settlement before concluding." }],details: {} };
    } },
  ];
  const delivered = new Set<string>();
  return { tools,
    collect: async () => (await port.settle(parent)).filter(child => !delivered.has(child.childId)).map(child => {
      delivered.add(child.childId);return { childId: child.childId,status: child.status,...(child.body === undefined ? {} : { body: child.body }) };
    }),
    close: async (cancel: boolean) => {
      try {
        try { if (cancel) await port.cancel(parent); }
        finally { await port.settle(parent); }
      } finally { signal?.removeEventListener("abort",abort);unregister();ceiling.dispose(); }
    },
  };
}
