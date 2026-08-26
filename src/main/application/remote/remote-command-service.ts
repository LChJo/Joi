import type { JoiInboxService } from "../joi/joi-inbox-service.js";
import type { JoiHomeFeedService } from "../joi/joi-home-feed-service.js";
import type { RemoteCommand, RemoteCommandResponse } from "../../../shared/remote.js";

const FORBIDDEN: NonNullable<RemoteCommandResponse["error"]> = {
  code: "remote_operation_forbidden",
  message: "This remote operation is not available.",
};

export class RemoteCommandService {
  constructor(private readonly dependencies: {
    homeFeed: Pick<JoiHomeFeedService, "load">;
    inbox: Pick<JoiInboxService, "accept">;
  }) {}

  async handle(command: RemoteCommand | { kind: string; requestId: string }): Promise<RemoteCommandResponse> {
    if (command.kind === "feed.get") {
      return { kind: "response", requestId: command.requestId, result: await this.dependencies.homeFeed.load() };
    }
    if (command.kind === "message.send" && "idempotencyKey" in command && "text" in command
      && typeof command.idempotencyKey === "string" && typeof command.text === "string") {
      return {
        kind: "response",
        requestId: command.requestId,
        result: await this.dependencies.inbox.accept({
          idempotencyKey: command.idempotencyKey,
          text: command.text.trim(),
        }),
      };
    }
    return { error: FORBIDDEN, kind: "response", requestId: command.requestId };
  }
}
