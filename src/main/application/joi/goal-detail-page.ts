import type { JoiGoalDetailPage } from "../../../shared/joi.js";
import { DomainError } from "../../domain/errors.js";

export function goalDetailPage(page: JoiGoalDetailPage): { offset: number; limit: number } {
  const offset = page.offset ?? 0;
  const limit = page.limit ?? 50;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new DomainError("goal_detail_page_invalid", "Goal detail paging is invalid.");
  }
  return { offset, limit };
}
