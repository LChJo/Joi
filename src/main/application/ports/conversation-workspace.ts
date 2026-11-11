import type { GitCommandInput, GitCommandDto, GitWorkspaceDto } from "../../../shared/conversations.js";
export interface ConversationWorkspacePort {
  status(workbenchId: string): Promise<GitWorkspaceDto>;
  diff(workbenchId: string, relativePath: string, staged: boolean): Promise<{ patch: string; truncated: boolean }>;
  files(workbenchId: string, directory: string): Promise<{ items: { path: string; directory: boolean }[] }>;
  file(workbenchId: string, relativePath: string): Promise<{ text: string; truncated: boolean }>;
  execute(workbenchId: string, input: GitCommandInput, signal?: AbortSignal): Promise<void>;
}
export interface GitCommandStore {
  submit(workbenchId: string, input: GitCommandInput, commandId: string, at: string): Promise<GitCommandDto>;
  get(id: string): Promise<(GitCommandDto & { workbenchId: string; input: GitCommandInput }) | null>;
  begin(id: string): Promise<boolean>;
  finish(id: string, errorCode?: string): Promise<void>;
  recoverInterrupted(): Promise<void>;
  stopQueued(): Promise<void>;
}
