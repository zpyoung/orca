import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const OWNER_DIRECTORY = 'src/main/fork-heimdall/orchestration/'
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
  const root = join(repoRoot, 'src/main/fork-heimdall')
  const files = collectTypeScriptFiles(root)
  const offenders = files
    .map((file) => relative(repoRoot, file).split('\\').join('/'))
    .filter((path) => !path.startsWith(OWNER_DIRECTORY))
    .filter((path) => IMPORT_PATTERN.test(codeText(readFileSync(join(repoRoot, path), 'utf8'))))

  it('walks the real feature tree rather than passing vacuously', () => {
    expect(files.length).toBeGreaterThan(5)
    expect(files.some((path) => path.includes('/orchestration/'))).toBe(true)
  })

  it('confines every upstream orchestration import to the adapter directory', () => {
    expect(offenders).toEqual([])
  })
})
