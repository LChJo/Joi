export type BoundaryResult = {
  allowed: boolean;
  reason?: string;
};

export function classifyProductionPath(filePath: string): string | null;
export function validateImport(sourcePath: string, target: string): BoundaryResult;
export function scanProductionBoundaries(root: string): Promise<{
  violations: string[];
  unclassified: string[];
}>;
