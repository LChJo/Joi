import type { IncomingMessage, ServerResponse } from "node:http";

import type { ApiDependencies } from "./api-dependencies.js";

export type RouteMatch = RegExpExecArray | "exact";

export interface RouteContext {
  dependencies: ApiDependencies;
  method: string;
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
}

/**
 * Authenticated route entry. The dispatcher runs `verifyWrite` before the
 * handler when `auth` is "write"; "read" routes only require the session gate.
 * Array order is significant and mirrors the historical if-chain.
 */
export interface RouteDefinition {
  auth: "read" | "write";
  id: string;
  match: (method: string, pathname: string) => RouteMatch | null;
  handle: (ctx: RouteContext, match: RouteMatch) => Promise<void> | void;
}

/** Pre-session routes (health, auth bootstrap/login/setup, authenticated artifact read). */
export interface PublicRouteDefinition {
  id: string;
  match: (method: string, pathname: string) => RouteMatch | null;
  handle: (ctx: RouteContext, match: RouteMatch) => Promise<void> | void;
}

export function exact(method: string, pathname: string): (requestMethod: string, requestPathname: string) => RouteMatch | null {
  return (requestMethod, requestPathname) => (requestMethod === method && requestPathname === pathname ? "exact" : null);
}

export function pattern(method: string, regex: RegExp): (requestMethod: string, requestPathname: string) => RouteMatch | null {
  return (requestMethod, requestPathname) => (requestMethod === method ? regex.exec(requestPathname) : null);
}
