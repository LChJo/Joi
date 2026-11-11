import type { RouteDefinition } from "../route-types.js";
import { CONVERSATION_ROUTES } from "./conversation-routes.js";
import { STATISTICS_ROUTES } from "./statistics-routes.js";
import { EVOLUTION_ROUTES } from "./evolution-routes.js";
import { RESULT_EXPORT_ROUTES } from "./result-export-routes.js";
import { AUTH_MUTATION_ROUTES, AUTH_SESSION_ROUTES } from "./auth-routes.js";
import { JOI_READ_ROUTES, JOI_WRITE_ROUTES } from "./joi-routes.js";
import { LEGACY_LIFE_ROUTES } from "./legacy-life-routes.js";
import { MODEL_SOURCE_READ_ROUTES, MODEL_SOURCE_WRITE_ROUTES } from "./model-source-routes.js";
import { PARTNER_CATALOG_ROUTES, PARTNER_MUTATION_ROUTES } from "./partner-routes.js";
import { PUBLIC_ROUTES } from "./public-routes.js";
import { AGENT_ROUTES, SYSTEM_ROUTES } from "./system-routes.js";
import { REMOTE_ROUTES } from "./remote-routes.js";
import { WORKBENCH_ROUTES } from "./workbench-routes.js";
import { AUTOMATION_READ_ROUTES, AUTOMATION_WRITE_ROUTES } from "./automation-routes.js";

/**
 * Authenticated route table. Families are disjoint path prefixes, so cross-family
 * order is behavior-neutral; within a family the historical if-chain order is kept.
 */
export const AUTHENTICATED_ROUTES: RouteDefinition[] = [
  ...CONVERSATION_ROUTES,
  ...STATISTICS_ROUTES,
  ...EVOLUTION_ROUTES,
  ...RESULT_EXPORT_ROUTES,
  ...AUTH_SESSION_ROUTES,
  ...MODEL_SOURCE_READ_ROUTES,
  ...JOI_READ_ROUTES,
  ...AUTOMATION_READ_ROUTES,
  ...PARTNER_CATALOG_ROUTES,
  ...WORKBENCH_ROUTES,
  ...PARTNER_MUTATION_ROUTES,
  ...JOI_WRITE_ROUTES,
  ...AUTOMATION_WRITE_ROUTES,
  ...MODEL_SOURCE_WRITE_ROUTES,
  ...AUTH_MUTATION_ROUTES,
  ...REMOTE_ROUTES,
  ...LEGACY_LIFE_ROUTES,
  ...AGENT_ROUTES,
  ...SYSTEM_ROUTES,
];

export { PUBLIC_ROUTES };

export const ROUTE_MANIFEST: string[] = [
  ...PUBLIC_ROUTES.map((route) => route.id),
  ...AUTHENTICATED_ROUTES.map((route) => route.id),
];
