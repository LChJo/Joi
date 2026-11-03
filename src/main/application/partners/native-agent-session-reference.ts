type NativeProtocol = "claude" | "codex";

export function toNativeAgentSessionRef(protocol: NativeProtocol, id: string): string {
  return `native-agent:v1:${protocol}:${id}`;
}

export function parseNativeAgentSessionRef(reference: string | undefined, protocol: NativeProtocol): string | undefined {
  if (reference === undefined) return undefined;
  const prefix = `native-agent:v1:${protocol}:`;
  if (!reference.startsWith(prefix)) return undefined;
  const id = reference.slice(prefix.length);
  return id.length === 0 || id.length > 512 ? undefined : id;
}
