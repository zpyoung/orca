const ORCA_DIRECTORY_RULE = /^\.orca(\/|\/\*)?\r?$/m
const BARE_ORCA_LINE = /^\.orca(\r\n|\n|\r|$)/gm
const ORCA_DIRECTORY_LINE = /^\.orca\/(\r\n|\n|\r|$)/gm

/** Return whether `.gitignore` has an exact root rule covering `.orca`. */
export function gitignoreAlreadyCoversOrcaDir(content: string): boolean {
  return ORCA_DIRECTORY_RULE.test(content)
}

/**
 * Replace bare root `.orca` rules while preserving line endings.
 * Leave user-authored `.orca/` rules unchanged.
 */
export function rewriteBareOrcaLine(content: string): { content: string; changed: boolean } {
  const fallbackLineEnding = content.match(/\r\n|\n|\r/)?.[0] ?? '\n'
  let changed = false
  const rewritten = content.replace(BARE_ORCA_LINE, (_line, ending: string) => {
    changed = true
    const lineEnding = ending || fallbackLineEnding
    return `.orca/*${lineEnding}!.orca/pipelines/${ending}`
  })
  return { content: rewritten, changed }
}

/**
 * Apply the explicit re-include action and preserve the file's line ending.
 * Rewrite exact `.orca/` rules and append the pipelines exception.
 */
export function reincludePipelines(content: string): string {
  const fallbackLineEnding = content.match(/\r\n|\n|\r/)?.[0] ?? '\n'
  let rewritten = content.replace(ORCA_DIRECTORY_LINE, (_line, ending: string) => {
    return `.orca/*${ending}`
  })
  if (rewritten.length > 0 && !rewritten.endsWith('\n') && !rewritten.endsWith('\r')) {
    rewritten += fallbackLineEnding
  }
  return `${rewritten}!.orca/pipelines/${fallbackLineEnding}`
}
