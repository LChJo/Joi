export function publishDesktopRelease(options: {
  directory: string;
  version: string;
  repository: string;
  sha: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<{ skipped: boolean; url: string }>;
