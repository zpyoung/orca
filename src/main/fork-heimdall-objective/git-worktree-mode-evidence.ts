import {
  OBJECTIVE_GIT_EXEC_PATH_BATCH_SIZE,
  OBJECTIVE_PATH_MODES_ALIAS,
  OBJECTIVE_PATH_MODES_ALIAS_CONFIG
} from '../../shared/fork-heimdall/objective-git-exec-shapes'
import type { ObjectiveGitCommand } from './content-identity'

export type GitPathModeEvidence = { modeIdentity: string; symlinkTarget?: string }

export async function gitPathModeEvidence(
  runGit: ObjectiveGitCommand,
  paths: readonly string[]
): Promise<GitPathModeEvidence[]> {
  const evidence: GitPathModeEvidence[] = []
  for (let index = 0; index < paths.length; index += OBJECTIVE_GIT_EXEC_PATH_BATCH_SIZE) {
    const batch = paths.slice(index, index + OBJECTIVE_GIT_EXEC_PATH_BATCH_SIZE)
    // Git !aliases use Git's bundled POSIX shell on Windows. Paths remain positional "$@"
    // arguments, never interpolated into shell source, so metacharacters cannot become syntax.
    const stdout = (
      await runGit([
        '-c',
        OBJECTIVE_PATH_MODES_ALIAS_CONFIG,
        OBJECTIVE_PATH_MODES_ALIAS,
        '--',
        ...batch
      ])
    ).stdout
    const fields = stdout.split('\0')
    if (fields.at(-1) === '') {
      fields.pop()
    }
    let fieldIndex = 0
    for (const path of batch) {
      const modeIdentity = fields[fieldIndex++]
      if (modeIdentity === 'symlink') {
        const rawTarget = fields[fieldIndex++]
        if (rawTarget === undefined || !rawTarget.endsWith('\n')) {
          throw new Error(`Git returned malformed symlink evidence for ${path}`)
        }
        evidence.push({ modeIdentity, symlinkTarget: rawTarget.slice(0, -1) })
      } else if (modeIdentity === 'file:executable' || modeIdentity === 'file:regular') {
        evidence.push({ modeIdentity })
      } else {
        throw new Error(`Git returned malformed worktree mode evidence for ${path}`)
      }
    }
    if (fieldIndex !== fields.length) {
      throw new Error('Git returned excess worktree mode evidence')
    }
  }
  return evidence
}
