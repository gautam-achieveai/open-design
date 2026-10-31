import type { ProjectFile, ProjectFileResponse, ProjectFileVersion, ProjectFileVersionPromptSource,
  ProjectFileVersionSource, ProjectFileVersionWarning, ProjectMetadata } from '@open-design/contracts';
import { createProjectArtifactFile } from '../artifacts/create.js';
import { validateArtifactManifestInput } from '../artifacts/manifest.js';
import { markProjectFileVersionStoreDeleted, withProjectFileVersionLock,
  type CreateProjectFileVersionOptions, type ProjectFileVersionLockContext } from '../project-file-versions.js';
import type { ReadProjectFile } from './project-file-read.js';
import type { ProjectFileCommitReceipt, ProjectFileMutationHooks, ProjectFileWriteOptions } from './project-file-mutation-hooks.js';

export type FileMutationProject = { id: string; metadata?: ProjectMetadata | null };
export type HtmlVersionOverride = Pick<CreateProjectFileVersionOptions, 'prompt' | 'promptSource' | 'source' | 'label' | 'parentVersionId'>;
export type LatestProjectPrompt = (project: FileMutationProject) => { prompt: string | null; promptSource?: Extract<ProjectFileVersionPromptSource, 'message' | 'project'> };
export interface ProjectFileOperationHooks extends ProjectFileMutationHooks { assertCurrent?: () => void }
export interface ProjectFileJsonWriteInput {
  name: string;
  content: string;
  encoding?: unknown;
  artifactManifest?: unknown;
  artifact?: unknown;
  overwrite?: unknown;
  source?: unknown;
  versionSource?: unknown;
  versionLabel?: unknown;
  versionPrompt?: unknown;
  parentVersionId?: unknown;
}

export function projectHtmlVersionOptions(project: FileMutationProject, override: HtmlVersionOverride | undefined,
  latestProjectPrompt: LatestProjectPrompt): CreateProjectFileVersionOptions {
  const fallback = latestProjectPrompt(project);
  const prompt = override?.prompt !== undefined
    ? (typeof override.prompt === 'string' && override.prompt.trim() ? override.prompt.trim() : null)
    : (override?.source === 'manual' || override?.source === 'restore' ? null : fallback.prompt);
  const promptSource = override?.promptSource ?? (override?.source === 'manual' ? 'manual'
    : override?.source === 'restore' ? 'restore' : fallback.promptSource);
  return { prompt, ...(promptSource ? { promptSource } : {}), ...(override?.source ? { source: override.source } : {}),
    ...(typeof override?.label === 'string' && override.label.trim() ? { label: override.label.trim() } : {}),
    ...(typeof override?.parentVersionId === 'string' && override.parentVersionId.trim() ? { parentVersionId: override.parentVersionId.trim() } : {}) };
}

export function projectFileVersionCaptureWarning(error: unknown): ProjectFileVersionWarning {
  return { code: 'PROJECT_FILE_VERSION_CAPTURE_FAILED', message: `HTML version could not be saved: ${error instanceof Error ? error.message : String(error)}` };
}

export async function matchProjectHtmlParentVersionId(project: FileMutationProject, name: string, requested: unknown,
  lock: Pick<ProjectFileVersionLockContext, 'matchVersionContent'>, projectsRoot: string, readProjectFile: ReadProjectFile): Promise<string | undefined> {
  if (typeof requested !== 'string' || !requested.trim()) return undefined;
  const id = requested.trim();
  try {
    const prior = await readProjectFile(projectsRoot, project.id, name, project.metadata);
    const match = await lock.matchVersionContent(prior.buffer.toString('utf8'), id);
    return match.status === 'matched' && match.version?.id === id ? id : undefined;
  } catch { return undefined; }
}

function uploadVersionSource(input: ProjectFileJsonWriteInput): ProjectFileVersionSource {
  const hasVersionSource = input.versionSource !== undefined && input.versionSource !== null;
  const value = hasVersionSource ? input.versionSource : input.source;
  if (value === undefined || value === null) return 'manual';
  if (value === 'ai' || value === 'manual' || value === 'restore') return value;
  throw new Error(`invalid ${hasVersionSource ? 'versionSource' : 'source'}; expected one of: ai, manual, restore`);
}

export function createProjectFileMutationOperations(deps: {
  projectsRoot: string;
  sanitizePath: (name: string) => string;
  readProjectFile: ReadProjectFile;
  writeProjectFile: (root: string, projectId: string, name: string, body: Buffer, options: ProjectFileWriteOptions,
    metadata?: unknown) => Promise<ProjectFile>;
  deleteProjectFile: (root: string, projectId: string, name: string, metadata?: unknown, hooks?: ProjectFileMutationHooks) => Promise<void>;
  latestProjectPrompt: LatestProjectPrompt;
  tombstoneWorkspaceArtifact: (projectId: string, requestedPath: string) => void;
  reportDeleteBookkeepingWarning: (error: unknown) => void;
}) {
  const writeJson = async (projectId: string, project: FileMutationProject | null | undefined, input: ProjectFileJsonWriteInput,
    hooks?: ProjectFileOperationHooks): Promise<{ response: ProjectFileResponse; receipt: ProjectFileCommitReceipt | null }> => {
    hooks?.assertCurrent?.();
    const desiredName = deps.sanitizePath(input.name);
    const source = project && /\.html?$/i.test(desiredName) ? uploadVersionSource(input) : null;
    if (input.artifactManifest !== undefined && input.artifactManifest !== null) {
      const validated = validateArtifactManifestInput(input.artifactManifest, input.name);
      if (!validated.ok) {
        const error = new Error(`invalid artifactManifest: ${validated.error}`);
        Object.assign(error, { code: 'ARTIFACT_MANIFEST_INVALID' });
        throw error;
      }
    }
    let receipt: ProjectFileCommitReceipt | null = null;
    const mutationHooks: ProjectFileMutationHooks = { ...hooks, contentCommitted: value => {
      receipt = value; hooks?.contentCommitted?.(value);
    } };
    const writeAndCapture = async (lock?: ProjectFileVersionLockContext) => {
      hooks?.assertCurrent?.();
      const parentVersionId = project && source === 'manual' && lock
        ? await matchProjectHtmlParentVersionId(project, desiredName, input.parentVersionId, lock, deps.projectsRoot, deps.readProjectFile) : undefined;
      hooks?.assertCurrent?.();
      const file = input.artifact === true ? await createProjectArtifactFile({ projectsRoot: deps.projectsRoot, projectId,
        input: { name: input.name, content: input.content, encoding: input.encoding === 'base64' ? 'base64' : 'utf8',
          artifactManifest: input.artifactManifest }, metadata: project?.metadata, writeProjectFile: deps.writeProjectFile, mutationHooks })
        : await deps.writeProjectFile(deps.projectsRoot, projectId, input.name,
          Buffer.from(input.content, input.encoding === 'base64' ? 'base64' : 'utf8'),
          { artifactManifest: input.artifactManifest, ...(input.overwrite === false ? { overwrite: false } : {}), mutationHooks }, project?.metadata);
      let capture: { version: ProjectFileVersion | null; versionWarning?: ProjectFileVersionWarning } | null = null;
      if (project && source && /\.html?$/i.test(file.name) && lock) {
        hooks?.assertCurrent?.();
        const saved = await deps.readProjectFile(deps.projectsRoot, project.id, file.name, project.metadata);
        hooks?.assertCurrent?.();
        const override: HtmlVersionOverride = { source, label: typeof input.versionLabel === 'string' ? input.versionLabel : null,
          ...(parentVersionId ? { parentVersionId } : {}),
          ...(typeof input.versionPrompt === 'string' ? { prompt: input.versionPrompt } : {}),
          ...(source === 'manual' ? { promptSource: 'manual' as const } : source === 'restore' ? { promptSource: 'restore' as const } : {}) };
        try {
          capture = { version: await lock.ensureCurrentVersion(saved.buffer.toString('utf8'), {
            ...projectHtmlVersionOptions(project, override, deps.latestProjectPrompt),
            ...(hooks?.beforeMutation ? { beforeMutation: hooks.beforeMutation } : {}),
          }) };
        } catch (error) { capture = { version: null, versionWarning: projectFileVersionCaptureWarning(error) }; }
      }
      const response: ProjectFileResponse = { file, ...(capture ? { version: capture.version } : {}),
        ...(capture?.versionWarning ? { versionWarning: capture.versionWarning } : {}) };
      return response;
    };
    const response = project && source ? await withProjectFileVersionLock(deps.projectsRoot, projectId, desiredName,
      project.metadata, lock => writeAndCapture(lock)) : await writeAndCapture();
    hooks?.assertCurrent?.();
    return { response, receipt };
  };

  const deleteFile = async (project: FileMutationProject, requestedPath: string, hooks?: ProjectFileOperationHooks): Promise<{
    response: { ok: true }; canonicalPath: string | null; bookkeepingWarning: boolean;
  }> => {
    hooks?.assertCurrent?.();
    let canonicalPath: string | null = null;
    await deps.deleteProjectFile(deps.projectsRoot, project.id, requestedPath, project.metadata, { ...hooks,
      fileDeleted: value => { canonicalPath = value; hooks?.fileDeleted?.(value); } });
    hooks?.assertCurrent?.();
    await markProjectFileVersionStoreDeleted(deps.projectsRoot, project.id, requestedPath, project.metadata, hooks?.beforeMutation);
    hooks?.beforeMutation?.();
    let bookkeepingWarning = false;
    try { deps.tombstoneWorkspaceArtifact(project.id, requestedPath); }
    catch (error) { bookkeepingWarning = true; deps.reportDeleteBookkeepingWarning(error); }
    hooks?.assertCurrent?.();
    return { response: { ok: true as const }, canonicalPath, bookkeepingWarning };
  };
  return { writeJson, deleteFile };
}

export type ProjectFileMutationOperations = ReturnType<typeof createProjectFileMutationOperations>;
