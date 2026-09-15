import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const OWNER_DIRECTORY = 'src/main/fork-heimdall/orchestration/'
const WATCHED_DIRECTORIES = [
  'src/main/fork-heimdall',
  'src/main/fork-heimdall-objective',
  'src/main/fork-hosted-review-sitter'
] as const
const IMPORT_PATTERN =
  /(?:from\s+['"][^'"]*(?:runtime\/orchestration|rpc\/methods\/orchestration)[^'"]*['"]|import\(\s*['"][^'"]*(?:runtime\/orchestration|rpc\/methods\/orchestration)[^'"]*['"]\s*\)|require\(\s*['"][^'"]*(?:runtime\/orchestration|rpc\/methods\/orchestration)[^'"]*['"]\s*\))/

function collectTypeScriptFiles(root: string): string[] {
  let found: string[] = []
  for (const entry of readdirSync(root)) {
    const full = join(root, entry)
    if (statSync(full).isDirectory()) {
      found = found.concat(collectTypeScriptFiles(full))
    } else if (full.endsWith('.ts') || full.endsWith('.tsx')) {
      found.push(full)
    }
  }
  return found
}

function codeText(contents: string): string {
  return contents.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('Heimdall orchestration import boundary', () => {
  const repoRoot = resolve(__dirname, '../../..')
  const files = WATCHED_DIRECTORIES.flatMap((directory) =>
    collectTypeScriptFiles(join(repoRoot, directory))
  )
  const offenders = files
    .map((file) => relative(repoRoot, file).split('\\').join('/'))
    .filter((path) => !path.startsWith(OWNER_DIRECTORY))
    .filter((path) => IMPORT_PATTERN.test(codeText(readFileSync(join(repoRoot, path), 'utf8'))))

  it('walks the kernel and both kind trees rather than passing vacuously', () => {
    expect(files.length).toBeGreaterThan(5)
    for (const directory of WATCHED_DIRECTORIES) {
      expect(files.some((file) => file.startsWith(join(repoRoot, directory)))).toBe(true)
    }
    expect(files.some((path) => path.includes('/orchestration/'))).toBe(true)
  })

  it('confines every upstream orchestration import to the adapter directory', () => {
    expect(offenders).toEqual([])
  })
})
