import { isFullGitObjectId } from '../git-handler-branch-diff-ops'
import {
  OBJECTIVE_GIT_EXEC_PATH_BATCH_SIZE,
  OBJECTIVE_PATH_MODES_ALIAS,
  OBJECTIVE_PATH_MODES_ALIAS_CONFIG,
  OBJECTIVE_SYMLINK_OID_ALIAS,
  OBJECTIVE_SYMLINK_OID_ALIAS_CONFIG
} from '../../shared/fork-heimdall/objective-git-exec-shapes'
import {
  hasSafeObjectivePaths,
  isSafeObjectiveLiteralPathspec,
  isSafeObjectiveRepositoryPath
} from './git-exec-path-allowlist'
import { isHeimdallObjectiveLandingGitExecArgs } from './git-exec-landing-allowlist'

const OBJECT_ID_PARENT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})\^$/iu
const MAX_NESTED_REPOSITORY_DEPTH = 8

function isAllowedStatus(args: readonly string[], offset: number): boolean {
  const length = args.length - offset
  return (
    (length === 5 &&
      args[offset + 1] === '--porcelain=v2' &&
      args[offset + 2] === '-z' &&
      args[offset + 3] === '--untracked-files=all' &&
      (args[offset + 4] === '--' || args[offset + 4] === '--ignore-submodules=none')) ||
    (length === 7 &&
      args[offset + 1] === '--porcelain=v2' &&
      args[offset + 2] === '--branch' &&
      args[offset + 3] === '-z' &&
      args[offset + 4] === '--untracked-files=all' &&
      args[offset + 5] === '--ignore-submodules=none' &&
      args[offset + 6] === '--')
  )
}

function isAllowedAlias(args: readonly string[], offset: number): boolean {
  if (args[offset] !== '-c') {
    return false
  }
  if (
    args.length - offset === 5 &&
    args[offset + 1] === OBJECTIVE_SYMLINK_OID_ALIAS_CONFIG &&
    args[offset + 2] === OBJECTIVE_SYMLINK_OID_ALIAS &&
    args[offset + 3] === '--'
  ) {
    return isSafeObjectiveRepositoryPath(args[offset + 4])
  }
  return (
    args[offset + 1] === OBJECTIVE_PATH_MODES_ALIAS_CONFIG &&
    args[offset + 2] === OBJECTIVE_PATH_MODES_ALIAS &&
    args[offset + 3] === '--' &&
    hasSafeObjectivePaths(args, offset + 4, OBJECTIVE_GIT_EXEC_PATH_BATCH_SIZE, false)
  )
}

function isAllowedLsTree(args: readonly string[], offset: number): boolean {
  const length = args.length - offset
  if (length === 3) {
    return args[offset + 1] === '-z' && isFullGitObjectId(args[offset + 2])
  }
  if (
    length === 6 &&
    args[offset + 1] === '-r' &&
    args[offset + 2] === '-z' &&
    isFullGitObjectId(args[offset + 3]) &&
    args[offset + 4] === '--'
  ) {
    return isSafeObjectiveLiteralPathspec(args[offset + 5])
  }
  return (
    args[offset + 1] === '-z' &&
    isFullGitObjectId(args[offset + 2]) &&
    args[offset + 3] === '--' &&
    hasSafeObjectivePaths(args, offset + 4, OBJECTIVE_GIT_EXEC_PATH_BATCH_SIZE, true)
  )
}

function isAllowedObjectiveRead(args: readonly string[], offset: number): boolean {
  if (isAllowedAlias(args, offset)) {
    return true
  }
  const command = args[offset]
  if (command === 'status') {
    return isAllowedStatus(args, offset)
  }
  if (command === 'hash-object') {
    return (
      args.length - offset === 3 &&
      args[offset + 1] === '--' &&
      isSafeObjectiveRepositoryPath(args[offset + 2])
    )
  }
  if (command === 'ls-tree') {
    return isAllowedLsTree(args, offset)
  }
  if (command === 'rev-parse') {
    return (
      args.length - offset === 3 &&
      args[offset + 1] === '--verify' &&
      (args[offset + 2] === 'HEAD' || args[offset + 2] === 'HEAD^{tree}')
    )
  }
  return false
}

function objectiveCommandOffset(args: readonly string[]): number {
  let offset = 0
  let depth = 0
  while (args[offset] === '-C') {
    if (depth >= MAX_NESTED_REPOSITORY_DEPTH || !isSafeObjectiveRepositoryPath(args[offset + 1])) {
      return -1
    }
    offset += 2
    depth++
  }
  return offset
}

function isAllowedObjectiveArgs(args: readonly string[]): boolean {
  const offset = objectiveCommandOffset(args)
  if (offset < 0 || offset >= args.length) {
    return false
  }
  if (offset > 0) {
    return isAllowedObjectiveRead(args, offset)
  }
  if (isAllowedObjectiveRead(args, offset)) {
    return true
  }

  const subcommand = args[0]
  let allowed: boolean
  switch (subcommand) {
    case 'reset':
      allowed =
        args.length === 3 &&
        (args[1] === '--mixed' || args[1] === '--hard') &&
        isFullGitObjectId(args[2])
      break
    case 'add': {
      const pathStart = args[2] === '--force' ? 4 : 3
      allowed =
        args[1] === '--all' &&
        args[pathStart - 1] === '--' &&
        hasSafeObjectivePaths(args, pathStart, OBJECTIVE_GIT_EXEC_PATH_BATCH_SIZE, true)
      break
    }
    case 'cherry-pick':
      allowed =
        (args.length === 2 && args[1] === '--abort') ||
        (args.length === 3 && args[1] === '--keep-redundant-commits' && isFullGitObjectId(args[2]))
      break
    case 'show':
      allowed =
        args.length === 4 &&
        args[1] === '--no-patch' &&
        args[2] === '--format=%an%x00%ae%x00%aI%x00%B' &&
        isFullGitObjectId(args[3])
      break
    case 'diff-tree': {
      const noRenamesOffset = args[3] === '--no-renames' ? 1 : 0
      const firstObject = args[5 + noRenamesOffset]
      allowed =
        args.length === 7 + noRenamesOffset &&
        args[1] === '--no-commit-id' &&
        args[2] === '--name-only' &&
        args[3 + noRenamesOffset] === '-r' &&
        args[4 + noRenamesOffset] === '-z' &&
        firstObject !== undefined &&
        (isFullGitObjectId(firstObject) || OBJECT_ID_PARENT_PATTERN.test(firstObject)) &&
        isFullGitObjectId(args[6 + noRenamesOffset])
      break
    }
    case 'cherry':
      allowed =
        args.length === 4 &&
        isFullGitObjectId(args[1]) &&
        isFullGitObjectId(args[2]) &&
        isFullGitObjectId(args[3])
      break
    default:
      return false
  }
  return allowed
}

/**
 * Admits only the exact argv shapes Heimdall objective execution emits. Every path operand follows
 * `--`, so these shapes bypass the incumbent per-subcommand rules without widening them.
 */
export function isHeimdallObjectiveGitExecArgs(args: readonly string[]): boolean {
  return isAllowedObjectiveArgs(args) || isHeimdallObjectiveLandingGitExecArgs(args)
}
