import type { JoiRuntimeDto, ModelSourceDto } from "../../../shared/joi.js";
import { isTransientModelSourceFailure } from "../../domain/model-sources/model-source-recovery-policy.js";

/** A configured route remains configured while its connection is temporarily unavailable. */
export function modelSourceRuntime(sources: readonly Pick<ModelSourceDto, "status" | "reasonCode">[]): JoiRuntimeDto {
  const ready = sources.filter(s => s.status === "READY").length;
  const recovering = sources.filter(s => s.status === "VALIDATING"
    || (s.status === "DEGRADED" && isTransientModelSourceFailure(s.reasonCode))).length;
  const unavailable = sources.filter(s => s.status === "DEGRADED" || s.status === "NEEDS_AUTH" || s.status === "VALIDATING").length;
  const configured = ready + unavailable > 0;
  const status = !configured ? "NOT_CONFIGURED" : unavailable === 0 ? "READY"
    : ready > 0 || recovering > 0 ? "DEGRADED" : "NEEDS_ATTENTION";
  return { configured, status, modelHealth: { ready, recovering, unavailable } };
}
