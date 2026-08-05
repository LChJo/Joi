import type { SseEvent } from "./runtime-store.js";
import type { WorkResult } from "../../domain/work/work-result.js";

export interface RecordedWorkResult {
  event: SseEvent;
  isAuthoritative: boolean;
  result: WorkResult;
}

export interface WorkResultRepository {
  readBody(input: { avatarId: string; limit: number; offset: number; resultId: string }): Promise<{ body: string; total: number } | null>;
  record(result: WorkResult): Promise<RecordedWorkResult>;
}
