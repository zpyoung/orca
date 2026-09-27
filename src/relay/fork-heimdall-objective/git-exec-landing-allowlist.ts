import { isFullGitObjectId } from '../git-handler-branch-diff-ops'
import { OBJECTIVE_GIT_EXEC_PATH_BATCH_SIZE } from '../../shared/fork-heimdall/objective-git-exec-shapes'
import { isSafeGitRemoteName } from '../../shared/git-push-target-validation'
import { hasSafeObjectivePaths } from './git-exec-path-allowlist'

const INVALID_BRANCH_CHARACTER = /[~^:?*[\]\\]/u

function isSafeBranchName(value: string): boolean {
  if (
    !value ||
    value.length > 1024 ||
    value === '@' ||
    value.startsWith('-') ||
    value.endsWith('.') ||
    value.includes('..') ||
    value.includes('@{') ||
    INVALID_BRANCH_CHARACTER.test(value)
  ) {
    return false
  }
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code <= 0x20 || code === 0x7f) {
      return false
    }
  }
  return !value
    .split('/')
    .some((component) => !component || component.startsWith('.') || component.endsWith('.lock'))
}

function isAllowedPush(args: readonly string[]): boolean {
  if (args.length !== 5 || args[1] !== '--porcelain' || !isSafeGitRemoteName(args[3] ?? '')) {
    return false
  }
  const refspec = args[4] ?? ''
  const separator = refspec.indexOf(':')
  if (separator < 1 || separator !== refspec.lastIndexOf(':')) {
    return false
  }
  const source = refspec.slice(0, separator)
  const destination = refspec.slice(separator + 1)
  const branch = destination.startsWith('refs/heads/')
    ? destination.slice('refs/heads/'.length)
    : ''
  if (!isFullGitObjectId(source) || !isSafeBranchName(branch)) {
    return false
  }
  const leasePrefix = `--force-with-lease=${destination}:`
  const lease = args[2] ?? ''
  if (!lease.startsWith(leasePrefix)) {
    return false
  }
  const expected = lease.slice(leasePrefix.length)
  return expected === '' || isFullGitObjectId(expected)
}

/** Exact mutating and recovery probes emitted by the objective landing ladder. */
export function isHeimdallObjectiveLandingGitExecArgs(args: readonly string[]): boolean {
  switch (args[0]) {
    case 'add':
      return (
        args[1] === '--' && hasSafeObjectivePaths(args, 2, OBJECTIVE_GIT_EXEC_PATH_BATCH_SIZE, true)
      )
    case 'commit':
      return (
        args[1] === '-m' &&
        Boolean(args[2]) &&
        !args[2]!.includes('\0') &&
        args[3] === '--' &&
        hasSafeObjectivePaths(args, 4, undefined, true)
      )
    case 'cat-file':
      return (
        args.length === 3 &&
        args[1] === '-e' &&
        /^(?:[0-9a-f]{40}|[0-9a-f]{64})\^\{commit\}$/iu.test(args[2] ?? '')
      )
    case 'rev-list':
      return (
        args.length === 5 &&
        args[1] === '--parents' &&
        args[2] === '-n' &&
        args[3] === '1' &&
        args[4] === 'HEAD'
      )
    case 'push':
      return isAllowedPush(args)
    default:
      return false
  }
}
