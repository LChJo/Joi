import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { LoopExecutionResources } from "@onkernel/browser-loop";
import type Kernel from "@onkernel/sdk";
import { DomainError } from "../../domain/errors.js";
import { PI_BROWSER_LOOP_TOOLS } from "../../domain/partners/pi-extension-tools.js";

/** A cloud browser belongs to one admitted execution and is never attached to a personal profile. */
export async function createBrowserLoopTools(allowed: ReadonlySet<string>) {
  const { loop,LoopExecutionResources } = await import("@onkernel/browser-loop");
  let pending: Promise<{ resources: LoopExecutionResources;client: Kernel;id: string }> | undefined;
  let closed = false;
  const provision = async () => {
    const apiKey = process.env.KERNEL_API_KEY;
    if (!apiKey?.trim()) throw new DomainError("browser_loop_credentials_required","Browser Loop requires a Kernel API key. Configure KERNEL_API_KEY and restart Joi.");
    const { default: Kernel } = await import("@onkernel/sdk");
    const client = new Kernel({ apiKey,maxRetries: 0,timeout: 30_000,logLevel: "off" });
    const browser = await client.browsers.create({ timeout_seconds: 600 });
    return { client,id: browser.session_id,resources: new LoopExecutionResources({ client,browser }) };
  };
  const tools: AgentTool[] = loop.toolsets.browser().filter(spec => (PI_BROWSER_LOOP_TOOLS as readonly string[]).includes(spec.name) && allowed.has(spec.name)).map(spec => ({
    name: spec.name,label: spec.name,description: spec.declaration.description,parameters: spec.declaration.parameters,
    execute: async (_id,params,signal) => {
      signal?.throwIfAborted();
      if (closed) throw new DomainError("browser_loop_closed","The browser execution has ended.");
      // Keep a failed provisioning attempt: an unknown creation outcome must not be replayed.
      const { resources } = await (pending ??= provision());
      signal?.throwIfAborted();
      return resources.materialize(spec).execute(params,signal);
    },
  } as AgentTool));
  return { tools,close: async () => {
    if (closed) return;
    closed = true;
    const active = await pending?.catch(() => undefined);
    if (active === undefined) return;
    try { await active.resources.dispose(); }
    finally { await active.client.browsers.deleteByID(active.id); }
  } };
}
