import type { ObjectiveGitCommand } from './content-identity'

const OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu
const RECOVERY_LOG_PAGE_SIZE = 32
const RECOVERY_LOG_MAX_CANDIDATES = 256

async function readRequiredCommit(runGit: ObjectiveGitCommand, revision: string): Promise<string> {
  const sha = (
    await runGit(['rev-parse', '--verify', '--quiet', `${revision}^{commit}`])
  ).stdout.trim()
  if (!OBJECT_ID_PATTERN.test(sha)) {
    throw new Error(`Git returned an invalid object id for ${revision}`)
  }
  return sha
}

async function commitAttribution(runGit: ObjectiveGitCommand, commitSha: string): Promise<string> {
  return (
    await runGit(['show', '--no-patch', '--format=%an%x00%ae%x00%aI%x00%B', commitSha])
  ).stdout.replace(/\r\n/gu, '\n')
}

async function commitIsEmpty(runGit: ObjectiveGitCommand, commitSha: string): Promise<boolean> {
  const parentSha = await readRequiredCommit(runGit, `${commitSha}^`)
  const { stdout } = await runGit([
    'diff-tree',
    '--no-commit-id',
    '--name-only',
    '-r',
    '-z',
    parentSha,
    commitSha
  ])
  return stdout === ''
}

async function candidateMatchesSource(
  runGit: ObjectiveGitCommand,
  sourceCommitSha: string,
  candidateCommitSha: string
): Promise<boolean> {
  const [sourceAttribution, candidateAttribution] = await Promise.all([
    commitAttribution(runGit, sourceCommitSha),
    commitAttribution(runGit, candidateCommitSha)
  ])
  if (sourceAttribution !== candidateAttribution) {
    return false
  }

  const [sourceEmpty, candidateEmpty] = await Promise.all([
    commitIsEmpty(runGit, sourceCommitSha),
    commitIsEmpty(runGit, candidateCommitSha)
  ])
  if (sourceEmpty || candidateEmpty) {
    return sourceEmpty && candidateEmpty
  }

  const candidateParent = await readRequiredCommit(runGit, `${candidateCommitSha}^`)
  const lines = (
    await runGit(['cherry', sourceCommitSha, candidateCommitSha, candidateParent])
  ).stdout
    .split(/\r?\n/u)
    .filter(Boolean)
  return lines.some(
    (line) => line === `- ${candidateCommitSha}` || line.startsWith(`- ${candidateCommitSha} `)
  )
}

async function readCandidatePage(args: {
  runGit: ObjectiveGitCommand
  mergeBase: string
  headSha: string
  skip: number
  limit: number
}): Promise<string[]> {
  const { stdout } = await args.runGit([
    'log',
    '--format=%H',
    '--no-merges',
    '--first-parent',
    `--max-count=${args.limit}`,
    `--skip=${args.skip}`,
    `${args.mergeBase}..${args.headSha}`
  ])
  const candidates = stdout.split(/\r?\n/u).filter(Boolean)
  if (candidates.length > args.limit || candidates.some((sha) => !OBJECT_ID_PATTERN.test(sha))) {
    throw new Error('Git returned malformed objective recovery history')
  }
  return candidates
}

/** Finds the actual rewritten commit without mistaking a later clean operator commit for it. */
export async function findIntegratedObjectiveCommit(args: {
  runGit: ObjectiveGitCommand
  sourceCommitSha: string
  mergeBase: string
  headSha: string
}): Promise<string | null> {
  for (let skip = 0; skip < RECOVERY_LOG_MAX_CANDIDATES; skip += RECOVERY_LOG_PAGE_SIZE) {
    const candidates = await readCandidatePage({
      ...args,
      skip,
      limit: RECOVERY_LOG_PAGE_SIZE
    })
    for (const candidate of candidates) {
      if (await candidateMatchesSource(args.runGit, args.sourceCommitSha, candidate)) {
        return candidate
      }
    }
    if (candidates.length < RECOVERY_LOG_PAGE_SIZE) {
      return null
    }
  }

  const overflow = await readCandidatePage({
    ...args,
    skip: RECOVERY_LOG_MAX_CANDIDATES,
    limit: 1
  })
  if (overflow.length > 0) {
    throw new Error('Objective recovery history exceeds the bounded candidate limit')
  }
  return null
}
