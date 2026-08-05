import type { JoiHomeFeedDto } from "../../../shared/joi.js";

export interface JoiHomeFeedRepository {
  load(now: Date): Promise<JoiHomeFeedDto>;
}
