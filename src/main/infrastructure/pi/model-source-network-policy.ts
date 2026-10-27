import { isIP } from "node:net";

import { DomainError } from "../../domain/errors.js";

type Resolver = (hostname: string) => Promise<string[]>;

export interface ApprovedModelSourceTarget {
  addresses: string[];
  hostname: string;
  local: boolean;
  origin: string;
  url: string;
}

function normalizedAddress(value: string): string {
  return value.toLowerCase().split("%", 1)[0] ?? value.toLowerCase();
}

function ipv4Octets(value: string): number[] | null {
  if (isIP(value) !== 4) return null;
  return value.split(".").map(Number);
}

function isLanAddress(value: string): boolean {
  const parts = ipv4Octets(value);
  if (parts === null) return false;
  const [first, second] = parts;
  return first === 10
    || first === 172 && second !== undefined && second >= 16 && second <= 31
    || first === 192 && second === 168;
}

function isPublicAddress(value: string): boolean {
  const address = normalizedAddress(value);
  const parts = ipv4Octets(address);
  if (parts !== null) {
    const [first, second, third] = parts;
    if (first === undefined || second === undefined || third === undefined) return false;
    return !(first === 0
      || first === 10
      || first === 100 && second >= 64 && second <= 127
      || first === 127
      || first === 169 && second === 254
      || first === 172 && second >= 16 && second <= 31
      || first === 192 && second === 0 && third === 0
      || first === 192 && second === 0 && third === 2
      || first === 192 && second === 168
      || first === 198 && (second === 18 || second === 19)
      || first === 198 && second === 51 && third === 100
      || first === 203 && second === 0 && third === 113
      || first >= 224);
  }
  if (isIP(address) !== 6) return false;
  return !(address === "::" || address === "::1" || address.startsWith("fc") || address.startsWith("fd")
    || /^fe[89ab]/u.test(address) || address.startsWith("ff") || address.startsWith("2001:db8")
    || address.startsWith("::ffff:"));
}

function literalHostname(url: URL): string {
  return url.hostname.startsWith("[") && url.hostname.endsWith("]") ? url.hostname.slice(1, -1) : url.hostname;
}

function prohibited(): DomainError {
  return new DomainError("model_source_url_prohibited", "Model source URL is not allowed.");
}

export class ModelSourceNetworkPolicy {
  constructor(private readonly dependencies: { resolve: Resolver }) {}

  async validate(value: string): Promise<ApprovedModelSourceTarget> {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw prohibited();
    }
    const hostname = literalHostname(url).toLowerCase();
    const local = hostname === "localhost" || hostname === "127.0.0.1";
    // Only a literal RFC1918 address opts into LAN access; DNS names remain public-only.
    const lan = isLanAddress(hostname);
    if (url.username !== "" || url.password !== "" || url.hash !== "" || url.search !== ""
      || (local || lan ? !new Set(["http:", "https:"]).has(url.protocol) : url.protocol !== "https:")) {
      throw prohibited();
    }
    if (isIP(hostname) !== 0 && !local && !lan && !isPublicAddress(hostname)) throw prohibited();

    const addresses = isIP(hostname) === 0 ? await this.dependencies.resolve(hostname) : [hostname];
    if (addresses.length === 0) throw prohibited();
    if (local) {
      if (addresses.some((address) => normalizedAddress(address) !== "127.0.0.1")) throw prohibited();
    } else if (!lan && addresses.some((address) => !isPublicAddress(address))) {
      throw prohibited();
    }
    url.hostname = url.hostname.toLowerCase();
    return { addresses: [...addresses], hostname, local, origin: url.origin, url: url.toString() };
  }

  async validateRedirect(input: { approved: ApprovedModelSourceTarget; location: string }): Promise<ApprovedModelSourceTarget> {
    let target: URL;
    try {
      target = new URL(input.location, input.approved.url);
    } catch {
      throw prohibited();
    }
    const validated = await this.validate(target.toString());
    if (validated.origin !== input.approved.origin) {
      throw new DomainError("model_source_redirect_cross_origin", "Model source redirects cannot change origin.");
    }
    return validated;
  }

  async revalidateConnection(approved: ApprovedModelSourceTarget): Promise<ApprovedModelSourceTarget> {
    return this.validate(approved.url);
  }
}
