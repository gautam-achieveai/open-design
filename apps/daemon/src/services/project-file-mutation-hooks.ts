export interface ProjectFileCommitReceipt {
  path: string;
  bytes: number;
  sha256: string;
}

/** Internal synchronous gates; these are never caller-supplied protocol fields. */
export interface ProjectFileMutationHooks {
  beforeMutation?: () => void;
  contentCommitted?: (receipt: ProjectFileCommitReceipt) => void;
  fileDeleted?: (canonicalPath: string) => void;
}

export interface ProjectFileWriteOptions {
  overwrite?: boolean;
  artifactManifest?: unknown;
  mutationHooks?: ProjectFileMutationHooks;
}
