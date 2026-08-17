/** Derives the `pipeline/<slug>-<runNumber>` git branch for a pipeline run (logic L8). */

/**
 * Slugifies a template name into a valid git ref-name segment: lowercased,
 * restricted to `[a-z0-9-]`, collapsed, trimmed, and capped at 40 characters.
 * Falls back to `run` when nothing valid remains.
 */
export function pipelineBranchSlug(templateName: string): string {
  const collapsed = templateName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  const truncated = collapsed.slice(0, 40)
  return truncated || 'run'
}

/**
 * Resolves the branch name for a pipeline run, appending the first free
 * numeric suffix (`-2`, `-3`, …) if `pipeline/<slug>-<runNumber>` is taken.
 * Performs no git I/O; existence is decided entirely by `existing`.
 */
export async function pipelineBranchName(
  slug: string,
  runNumber: number,
  existing: (name: string) => Promise<boolean>
): Promise<string> {
  const base = `pipeline/${slug}-${runNumber}`
  if (!(await existing(base))) {
    return base
  }
  for (let suffix = 2; ; suffix++) {
    const candidate = `${base}-${suffix}`
    if (!(await existing(candidate))) {
      return candidate
    }
  }
}
