import { TextDecoder } from 'node:util'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { checkIgnoredPaths as checkIgnoredPathsLocally } from '../git/check-ignored-paths'
import { isENOENT } from '../ipc/filesystem-auth'
import { requireSshGitProvider } from '../providers/ssh-git-dispatch'
import { requireSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { joinWorktreeRelativePath } from '../runtime/runtime-relative-paths'
import { reincludePipelines, rewriteBareOrcaLine } from './orca-gitignore-rules'

const STILL_IGNORED_DETAIL = "ignored by a rule outside Orca's .orca line"

type PipelineTrackingTarget = {
  repoPath: string
  worktreePath: string
  connectionId: string | null
  pipelineId: string
}

type PipelineTrackingDependencies = {
  checkIgnoredPaths(paths: string[]): Promise<string[]>
  readGitignore(): Promise<string | null>
  writeGitignore(content: string): Promise<void>
}

type PipelineTrackingResult = {
  status: 'tracked' | 'rewrote-orca-line' | 'still-ignored'
  detail?: string
}

function defaultDependencies(target: PipelineTrackingTarget): PipelineTrackingDependencies {
  const { connectionId, worktreePath } = target
  const gitignorePath = connectionId
    ? joinWorktreeRelativePath(worktreePath, '.gitignore')
    : join(worktreePath, '.gitignore')

  return {
    checkIgnoredPaths(paths) {
      return connectionId
        ? requireSshGitProvider(connectionId).checkIgnoredPaths(worktreePath, paths)
        : checkIgnoredPathsLocally(worktreePath, paths)
    },
    async readGitignore() {
      if (connectionId) {
        try {
          const result = await requireSshFilesystemProvider(connectionId).readFile(gitignorePath)
          if (result.isBinary) {
            throw new Error('The root .gitignore is not valid UTF-8 text')
          }
          return result.content
        } catch (error) {
          if (isENOENT(error)) {
            return null
          }
          throw error
        }
      }
      try {
        const content = await readFile(gitignorePath)
        return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content)
      } catch (error) {
        if (isENOENT(error)) {
          return null
        }
        throw error
      }
    },
    async writeGitignore(content) {
      if (connectionId) {
        await requireSshFilesystemProvider(connectionId).writeFile(gitignorePath, content)
        return
      }
      await writeFile(gitignorePath, content, 'utf8')
    }
  }
}

/**
 * Make a saved repository pipeline visible to Git without editing other ignore rules.
 * Rewrite only bare `.orca` rules and report when another rule still ignores the file.
 * Call only for Git workspaces; the caller gates folder workspaces.
 */
export async function ensurePipelineTracked(
  target: PipelineTrackingTarget,
  deps: PipelineTrackingDependencies = defaultDependencies(target)
): Promise<PipelineTrackingResult> {
  const pipelinePath = `.orca/pipelines/${target.pipelineId}.yaml`
  if (!(await deps.checkIgnoredPaths([pipelinePath])).includes(pipelinePath)) {
    return { status: 'tracked' }
  }

  const gitignore = await deps.readGitignore()
  if (gitignore === null) {
    return { status: 'still-ignored', detail: STILL_IGNORED_DETAIL }
  }

  const rewritten = rewriteBareOrcaLine(gitignore)
  if (!rewritten.changed) {
    return { status: 'still-ignored', detail: STILL_IGNORED_DETAIL }
  }

  await deps.writeGitignore(rewritten.content)
  if ((await deps.checkIgnoredPaths([pipelinePath])).includes(pipelinePath)) {
    return { status: 'still-ignored', detail: STILL_IGNORED_DETAIL }
  }
  return { status: 'rewrote-orca-line' }
}

/**
 * Apply the explicit re-include action on the target host, then verify Git visibility.
 * This is the only tracking operation that rewrites an exact user-authored `.orca/` rule.
 * Call only after resolving a Git worktree.
 */
export async function reincludePipelineFiles(
  target: PipelineTrackingTarget,
  deps: PipelineTrackingDependencies = defaultDependencies(target)
): Promise<PipelineTrackingResult> {
  const gitignore = await deps.readGitignore()
  await deps.writeGitignore(reincludePipelines(gitignore ?? ''))
  const pipelinePath = `.orca/pipelines/${target.pipelineId}.yaml`
  if ((await deps.checkIgnoredPaths([pipelinePath])).includes(pipelinePath)) {
    return { status: 'still-ignored', detail: STILL_IGNORED_DETAIL }
  }
  return { status: 'tracked' }
}
