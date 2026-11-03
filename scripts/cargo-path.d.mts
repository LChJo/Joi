export function resolveCargo(options?: {
  environment?: Record<string, string | undefined>;
  homeDirectory?: string;
}): Promise<string | undefined>;
