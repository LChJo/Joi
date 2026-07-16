import { isIP } from "node:net";

import { DomainError } from "../../domain/errors.js";

type Resolver = (hostname: string) => Promise<string[]>;

function ipv4Octets(address: string): number[] | null {
  if (isIP(address) !== 4) return null;
  return address.split(".").map(Number);
}

function isPrivateOrLoopback(address: string): boolean {
  if (address === "::1") return true;
  const parts = ipv4Octets(address);
  if (parts === null) return false;
  const [first, second] = parts;
  return first === 127 || first === 10 || (first === 172 && second !== undefined && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

function isDangerous(address: string): boolean {
  if (isPrivateOrLoopback(address)) return false;
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    return normalized === "::" || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb") || normalized.startsWith("ff");
  }
  const parts = ipv4Octets(address);
  if (parts === null) return true;
  const [first, second, third] = parts;
  return first === 0
    || first === 169 && second === 254
    || first !== undefined && first >= 224
    || first === 100 && second !== undefined && second >= 64 && second <= 127
    || first === 192 && second === 0 && third === 0
    || first === 192 && second === 0 && third === 2
    || first === 198 && second === 18
    || first === 198 && second === 19
    || first === 198 && second === 51 && third === 100
    || first === 203 && second === 0 && third === 113;
}

export class OutboundNetworkPolicy {
  constructor(private readonly dependencies: { resolve: Resolver }) {}

  async validate(value: string, options: { rejectQuery?: boolean } = {}) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new DomainError("agent_card_invalid", "Agent URL is invalid.");
    }
    if (!new Set(["http:", "https:"]).has(url.protocol)
      || url.username !== ""
      || url.password !== ""
      || url.hash !== ""
      || (options.rejectQuery === true && url.search !== "")) {
      throw new DomainError("agent_card_invalid", "Agent URL contains a forbidden scheme, credential, query, or fragment.");
    }
    const addresses = isIP(url.hostname) === 0 ? await this.dependencies.resolve(url.hostname) : [url.hostname];
    if (addresses.length === 0 || addresses.some(isDangerous)) {
      throw new DomainError("agent_card_invalid", "Agent URL resolves to a prohibited address.");
    }
    if (url.protocol === "http:" && addresses.some((address) => !isPrivateOrLoopback(address))) {
      throw new DomainError("agent_card_invalid", "Plain HTTP Agent URLs must resolve only to loopback or RFC1918 addresses.");
    }
    url.hostname = url.hostname.toLowerCase();
    return { addresses, origin: url.origin, url: url.toString() };
  }

  async validateRedirect(input: { bearerOrigin?: string; from: string; location: string }) {
    let redirect: URL;
    try {
      redirect = new URL(input.location, input.from);
    } catch {
      throw new DomainError("agent_card_invalid", "Agent redirect URL is invalid.");
    }
    const validated = await this.validate(redirect.toString());
    if (input.bearerOrigin !== undefined && validated.origin !== input.bearerOrigin) {
      throw new DomainError("agent_reconfirm_required", "Bearer credentials cannot follow a cross-Origin redirect.");
    }
    return validated;
  }
}
