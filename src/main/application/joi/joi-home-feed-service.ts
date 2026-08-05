import type { JoiHomeFeedDto } from "../../../shared/joi.js";
import type { JoiHomeFeedRepository } from "../ports/joi-home-feed.js";
import type { Clock } from "../ports/runtime-store.js";

export class JoiHomeFeedService {
  constructor(private readonly dependencies: { clock: Clock; repository: JoiHomeFeedRepository }) {}

  load(): Promise<JoiHomeFeedDto> {
    return this.dependencies.repository.load(this.dependencies.clock.now());
  }
}
