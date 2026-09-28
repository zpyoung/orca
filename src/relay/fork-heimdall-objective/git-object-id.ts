// Why a fork copy: importing the upstream helper from git-handler-branch-diff-ops closes an import
// cycle through git-exec-validator, which registers this allowlist.
const FULL_GIT_OBJECT_ID_PATTERN = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/

export function isFullGitObjectId(value: unknown): value is string {
  return typeof value === 'string' && FULL_GIT_OBJECT_ID_PATTERN.test(value)
}
