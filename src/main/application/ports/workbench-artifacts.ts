export type WorkbenchArtifactOpenMode = "OPEN" | "REVEAL";
export type WorkbenchArtifactSource = "AGENT" | "GOAL";

export interface ResolvedWorkbenchArtifact {
  kind: "DIRECTORY" | "FILE";
  targetPath: string;
}

export interface WorkbenchArtifactOpener {
  open(input: ResolvedWorkbenchArtifact & { mode: WorkbenchArtifactOpenMode }): Promise<void>;
}

export interface WorkbenchArtifactResolutionInput {
  artifactId: string;
  source: WorkbenchArtifactSource;
  sourceId: string;
  workbenchId: string;
}
