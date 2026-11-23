import { Agent, get } from "node:http";
import { workerData, type MessagePort } from "node:worker_threads";
import type { JoiGoalDetailDto, WorkbenchAgentCardDto } from "../../src/shared/joi.js";
import { WorkerRpc } from "../../src/main/infrastructure/runtime/worker-rpc.js";

export interface GoalHttpSample {
  agents: { status: number; elapsedMs: number; ids: string[] }[];
  health: { status: number | undefined; elapsedMs: number };
  summary: { status: number; pathCount: number | undefined; totalWorks: number | undefined };
}

interface Input {
  port: MessagePort;
  agentsUrl: string;
  detailUrl: string;
  healthUrl: string;
  clients: [{ cookie: string },{ cookie: string }];
}

const input = workerData as Input;
const healthAgent = new Agent({ keepAlive: true });

async function readAgents(headers: { cookie: string }) {
  const started = performance.now();
  const response = await fetch(`${input.agentsUrl}&limit=100`,{ headers,signal: AbortSignal.timeout(5_000) });
  const page = await response.json() as { items?: WorkbenchAgentCardDto[] };
  return { status: response.status,elapsedMs: performance.now() - started,ids: page.items?.map(item => item.agentId) ?? [] };
}

function readHealth(): Promise<GoalHttpSample["health"]> {
  const started = performance.now();
  return new Promise((resolve,reject) => {
    get(input.healthUrl,{ agent: healthAgent,signal: AbortSignal.timeout(5_000) },response => {
      response.on("error",reject);
      response.once("end",() => resolve({ status: response.statusCode,elapsedMs: performance.now() - started }));
      response.resume();
    }).on("error",reject);
  });
}

async function readSummary() {
  const response = await fetch(`${input.detailUrl}?view=summary`,{ headers: input.clients[1],signal: AbortSignal.timeout(5_000) });
  const detail = await response.json() as JoiGoalDetailDto;
  return { status: response.status,pathCount: detail.harness?.paths.length,totalWorks: detail.harness?.progress?.work.total };
}

new WorkerRpc(input.port,{
  sample: async (count) => {
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 40) throw new Error("invalid_sample_count");
    const samples: GoalHttpSample[] = [];
    for (let index = 0; index < count; index++) {
      const [agents,health,summary] = await Promise.all([Promise.all(input.clients.map(readAgents)),readHealth(),readSummary()]);
      samples.push({ agents,health,summary });
    }
    return samples;
  },
});
