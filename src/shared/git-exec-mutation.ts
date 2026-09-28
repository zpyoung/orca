const MUTATING_GIT_EXEC_SUBCOMMANDS: Record<string, true> = {
  add: true,
  'cherry-pick': true,
  clone: true,
  commit: true,
  init: true,
  push: true,
  reset: true
}
// Why: `git remote` also serves the bare list and get-url reads, so only the
// permitted fork-remote writes may invalidate cached reads.
const MUTATING_GIT_REMOTE_ACTIONS: Record<string, true> = {
  add: true,
  remove: true
}
const GIT_GLOBAL_OPTIONS_WITH_SEPARATE_VALUE: Record<string, true> = {
  '-c': true,
  '-C': true,
  '--config-env': true,
  '--git-dir': true,
  '--namespace': true,
  '--super-prefix': true,
  '--work-tree': true
}

function gitSubcommandIndex(args: readonly string[]): number {
  let index = 0
  while (index < args.length) {
    const arg = args[index] ?? ''
    if (!arg.startsWith('-')) {
      return index
    }
    if (arg === '--') {
      return -1
    }
    index += GIT_GLOBAL_OPTIONS_WITH_SEPARATE_VALUE[arg] === true ? 2 : 1
  }
  return -1
}

// Why: relay git.exec permits these narrow write shapes alongside read-only
// probes, so cache invalidation must distinguish them before dispatch. Native
// callers can also supply Git-global options before the command; those options
// must not hide a mutating subcommand from either client- or relay-side caches.
export function gitExecMutatesRepository(args: readonly string[]): boolean {
  const subcommandIndex = gitSubcommandIndex(args)
  if (subcommandIndex < 0) {
    return false
  }
  const subcommand = args[subcommandIndex] ?? ''
  if (subcommand === 'remote') {
    for (let index = subcommandIndex + 1; index < args.length; index++) {
      const action = args[index] ?? ''
      if (!action.startsWith('-')) {
        return MUTATING_GIT_REMOTE_ACTIONS[action] === true
      }
    }
    return false
  }
  return MUTATING_GIT_EXEC_SUBCOMMANDS[subcommand] === true
}
