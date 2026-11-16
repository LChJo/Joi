export function planDesktopRelease(options: {
  version?: string;
  repository?: string;
  token?: string;
  ref?: string;
  eventName?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ publish: boolean; previousTag?: string; url?: string }>;
