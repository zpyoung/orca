import { readFileSync, readdirSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const OWNER_DIRECTORY = 'src/main/fork-heimdall/orchestration/'
const FEATURE_DIRECTORY_NAMES: Record<string, true> = {
  'fork-heimdall': true,
  'fork-heimdall-objective': true,
  'fork-hosted-review-sitter': true
}
const EXPECTED_FEATURE_DIRECTORIES = [
  'src/cli/fork-heimdall',
  'src/main/fork-heimdall',
  'src/main/fork-heimdall-objective',
  'src/main/fork-hosted-review-sitter',
  'src/main/host/fork-heimdall',
  'src/main/runtime/rpc/methods/fork-heimdall',
  'src/main/runtime/rpc/methods/fork-heimdall-objective',
  'src/preload/fork-heimdall',
  'src/preload/fork-hosted-review-sitter',
  'src/relay/fork-hosted-review-sitter',
  'src/renderer/src/fork-heimdall',
  'src/renderer/src/fork-heimdall-objective',
  'src/renderer/src/fork-hosted-review-sitter',
  'src/renderer/src/store/slices/fork-heimdall',
  'src/shared/fork-heimdall',
  'src/shared/fork-heimdall-objective',
  'src/shared/fork-hosted-review-sitter'
]
const IMPORT_PATTERN =
  /(?:from\s+['"][^'"]*(?:runtime\/orchestration|rpc\/methods\/orchestration)[^'"]*['"]|import\(\s*['"][^'"]*(?:runtime\/orchestration|rpc\/methods\/orchestration)[^'"]*['"]\s*\)|require\(\s*['"][^'"]*(?:runtime\/orchestration|rpc\/methods\/orchestration)[^'"]*['"]\s*\))/

function collectFeatureDirectories(root: string): string[] {
  if (Object.hasOwn(FEATURE_DIRECTORY_NAMES, basename(root))) {
    return [root]
  }
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? collectFeatureDirectories(join(root, entry.name)) : []
  )
}

function collectTypeScriptFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const full = join(root, entry.name)
    if (entry.isDirectory()) {
      return collectTypeScriptFiles(full)
    }
    return full.endsWith('.ts') || full.endsWith('.tsx') ? [full] : []
  })
}

function codeText(contents: string): string {
  return contents.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('Heimdall orchestration import boundary', () => {
  const repoRoot = resolve(__dirname, '../../..')
  const featureDirectories = collectFeatureDirectories(join(repoRoot, 'src'))
  const files = featureDirectories.flatMap(collectTypeScriptFiles)
  const offenders = files
    .map((file) => relative(repoRoot, file).split('\\').join('/'))
    .filter((path) => !path.startsWith(OWNER_DIRECTORY))
    .filter((path) => IMPORT_PATTERN.test(codeText(readFileSync(join(repoRoot, path), 'utf8'))))

  it('walks every existing layer of the kernel and both kinds rather than passing vacuously', () => {
    const relativeDirectories = featureDirectories.map((directory) =>
      relative(repoRoot, directory).split('\\').join('/')
    )
    expect(relativeDirectories).toEqual(expect.arrayContaining(EXPECTED_FEATURE_DIRECTORIES))
    for (const feature of Object.keys(FEATURE_DIRECTORY_NAMES)) {
      expect(relativeDirectories.some((directory) => basename(directory) === feature)).toBe(true)
    }
    expect(files.some((path) => path.includes('/orchestration/'))).toBe(true)
  })

  it('confines every upstream orchestration import to the adapter directory', () => {
    expect(offenders).toEqual([])
  })
})
