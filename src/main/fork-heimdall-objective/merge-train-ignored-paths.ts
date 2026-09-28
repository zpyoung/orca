import { posix, win32 } from 'node:path'
import { OBJECTIVE_GIT_EXEC_PATH_BATCH_SIZE } from '../../shared/fork-heimdall/objective-git-exec-shapes'
import { isObjectiveMetadataPath, type ObjectiveGitCommand } from './content-identity'

function assertSafeReportedPath(filePath: string, caseInsensitivePaths: boolean): void {
  const invalid =
    !filePath ||
    filePath.includes('\0') ||
    posix.isAbsolute(filePath) ||
    win32.isAbsolute(filePath) ||
    /^[A-Za-z]:/u.test(filePath) ||
    /(?:^|[\\/])\.{1,2}(?:[\\/]|$)/u.test(filePath) ||
    /[\\/]{2}|[\\/]$/u.test(filePath) ||
    isObjectiveMetadataPath(filePath.replaceAll('\\', '/'), caseInsensitivePaths)
  if (invalid) {
    throw new Error(`Reported objective path is not a safe repository file: ${filePath}`)
  }
}

/** Resolves only explicitly reported, existing ignored files; directories cannot widen the result. */
export async function findReportedIgnoredPaths(args: {
  runGit: ObjectiveGitCommand
  reportedPaths: readonly string[]
  caseInsensitivePaths: boolean
}): Promise<string[]> {
  const reported = new Set<string>()
  for (const filePath of args.reportedPaths) {
    assertSafeReportedPath(filePath, args.caseInsensitivePaths)
    reported.add(filePath)
  }
  const candidates = [...reported].sort()
  const ignored = new Set<string>()
  for (let index = 0; index < candidates.length; index += OBJECTIVE_GIT_EXEC_PATH_BATCH_SIZE) {
    const batch = candidates.slice(index, index + OBJECTIVE_GIT_EXEC_PATH_BATCH_SIZE)
    const { stdout } = await args.runGit([
      'ls-files',
      '--others',
      '--ignored',
      '--exclude-standard',
      '-z',
      '--',
      ...batch.map((filePath) => `:(literal)${filePath}`)
    ])
    for (const filePath of stdout.split('\0')) {
      if (
        reported.has(filePath) &&
        !isObjectiveMetadataPath(filePath.replaceAll('\\', '/'), args.caseInsensitivePaths)
      ) {
        ignored.add(filePath)
      }
    }
  }
  return [...ignored].sort()
}
