const OBJECTIVE_GIT_OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu

export function isObjectiveGitObjectId(value: string): boolean {
  return OBJECTIVE_GIT_OBJECT_ID_PATTERN.test(value)
}
