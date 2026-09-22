const LITERAL_PATHSPEC_PREFIX = ':(literal)'

export function isSafeObjectiveRepositoryPath(value: string | undefined): boolean {
  if (!value || value.includes('\0')) {
    return false
  }
  const firstCharacter = value[0]
  const driveQualifiedPath =
    firstCharacter !== undefined &&
    ((firstCharacter >= 'A' && firstCharacter <= 'Z') ||
      (firstCharacter >= 'a' && firstCharacter <= 'z')) &&
    value[1] === ':'
  if (firstCharacter === '/' || firstCharacter === '\\' || driveQualifiedPath) {
    return false
  }
  let componentStart = 0
  let firstComponent = ''
  for (let index = 0; index <= value.length; index++) {
    if (index < value.length && value[index] !== '/' && value[index] !== '\\') {
      continue
    }
    const component = value.slice(componentStart, index)
    if (
      !component ||
      component === '.' ||
      component === '..' ||
      component.toLowerCase() === '.git'
    ) {
      return false
    }
    if (componentStart === 0) {
      firstComponent = component.toLowerCase()
    }
    componentStart = index + 1
  }
  return firstComponent !== '.orca'
}

export function isSafeObjectiveLiteralPathspec(value: string | undefined): boolean {
  return (
    value !== undefined &&
    value.startsWith(LITERAL_PATHSPEC_PREFIX) &&
    isSafeObjectiveRepositoryPath(value.slice(LITERAL_PATHSPEC_PREFIX.length))
  )
}

export function hasSafeObjectivePaths(
  args: readonly string[],
  start: number,
  maximum: number | undefined,
  literalPathspecs: boolean
): boolean {
  const count = args.length - start
  if (count < 1 || (maximum !== undefined && count > maximum)) {
    return false
  }
  for (let index = start; index < args.length; index++) {
    const safe = literalPathspecs
      ? isSafeObjectiveLiteralPathspec(args[index])
      : isSafeObjectiveRepositoryPath(args[index])
    if (!safe) {
      return false
    }
  }
  return true
}
