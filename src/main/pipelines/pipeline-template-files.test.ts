import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import type { PathLike } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_ORCA_YAML_BYTES } from '../../shared/orca-yaml-file-limit'
import { BUGFIX_FAST_STARTER_TEMPLATE } from './pipeline-starter-template'
import {
  ensureStarterTemplate,
  getPipelineTemplatesDir,
  listPipelineTemplateFiles
} from './pipeline-template-files'

// hooks let individual tests observe/react to a real fs call from inside the module under
// test, to simulate a race landing between that call and the next one
let onReaddirSync: ((path: PathLike) => void) | undefined
let onRealpathSync: ((path: PathLike) => void) | undefined
let forceZeroIdentity = false

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return {
    ...actual,
    readdirSync: ((...args: Parameters<typeof actual.readdirSync>) => {
      const result = actual.readdirSync(...args)
      onReaddirSync?.(args[0])
      return result
    }) as typeof actual.readdirSync,
    realpathSync: ((...args: Parameters<typeof actual.realpathSync>) => {
      const result = actual.realpathSync(...args)
      onRealpathSync?.(args[0])
      return result
    }) as typeof actual.realpathSync,
    fstatSync: ((...args: Parameters<typeof actual.fstatSync>) => {
      const result = actual.fstatSync(...args)
      if (forceZeroIdentity) {
        result.dev = 0
        result.ino = 0
      }
      return result
    }) as typeof actual.fstatSync,
    lstatSync: ((path: PathLike) => {
      const result = actual.lstatSync(path)
      if (forceZeroIdentity) {
        result.dev = 0
        result.ino = 0
      }
      return result
    }) as typeof actual.lstatSync
  }
})

// mimics this project's bundler by retrying an unresolved extensionless relative import
// with a `.ts` suffix, so the child process below loads the real shipped module
const SUBPROCESS_RESOLVER_HOOK = `
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (err) {
    if (specifier.startsWith('.') && !/\\.[a-zA-Z0-9]+$/.test(specifier)) {
      return nextResolve(specifier + '.ts', context)
    }
    throw err
  }
}
`

const SUBPROCESS_ENTRY_SCRIPT = `
import { register } from 'node:module'
register('data:text/javascript,' + encodeURIComponent(${JSON.stringify(SUBPROCESS_RESOLVER_HOOK)}))
const [, , targetUrl, dirArg] = process.argv
const { listPipelineTemplateFiles } = await import(targetUrl)
const files = listPipelineTemplateFiles(dirArg)
process.stdout.write(JSON.stringify(files.map((f) => f.basename)))
`

// a blocking open() blocks the whole process synchronously, so only an external process
// timeout — not a same-process timer — can bound a call that regresses into hanging
function runListPipelineTemplateFilesInSubprocess(templatesDir: string): string[] {
  const scratchDir = mkdtempSync(join(tmpdir(), 'orca-fifo-subprocess-'))
  try {
    const entryPath = join(scratchDir, 'entry.mjs')
    writeFileSync(entryPath, SUBPROCESS_ENTRY_SCRIPT, 'utf8')
    const targetUrl = new URL('./pipeline-template-files.ts', import.meta.url).href
    const stdout = execFileSync(
      process.execPath,
      ['--experimental-strip-types', entryPath, targetUrl, templatesDir],
      { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    )
    return JSON.parse(stdout)
  } finally {
    rmSync(scratchDir, { recursive: true, force: true })
  }
}

const canCreateFifo = (() => {
  const probeDir = mkdtempSync(join(tmpdir(), 'orca-fifo-probe-'))
  try {
    execFileSync('mkfifo', [join(probeDir, 'p')])
    return true
  } catch {
    return false
  } finally {
    rmSync(probeDir, { recursive: true, force: true })
  }
})()

describe('getPipelineTemplatesDir', () => {
  it('resolves to <home>/.orca/pipelines', () => {
    expect(getPipelineTemplatesDir('/home/test')).toBe(join('/home/test', '.orca', 'pipelines'))
  })
})

describe('pipeline-template-files', () => {
  let root: string
  let dir: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-pipeline-templates-'))
    dir = join(root, '.orca', 'pipelines')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  describe('ensureStarterTemplate', () => {
    it('creates the directory and writes the starter file when absent', () => {
      const result = ensureStarterTemplate(dir)

      expect(result).toEqual({ created: true, path: join(dir, 'bugfix-fast.yaml') })
      expect(readFileSync(result.path, 'utf8')).toBe(BUGFIX_FAST_STARTER_TEMPLATE)
    })

    it('writes atomically, leaving no .tmp file behind', () => {
      const result = ensureStarterTemplate(dir)

      expect(existsSync(`${result.path}.tmp`)).toBe(false)
    })

    it('never overwrites an existing file of the same name', () => {
      mkdirSync(dir, { recursive: true })
      const path = join(dir, 'bugfix-fast.yaml')
      writeFileSync(path, 'user: customized\n', 'utf8')
      const mtimeBefore = statSync(path).mtimeMs

      const result = ensureStarterTemplate(dir)

      expect(result).toEqual({ created: false, path })
      expect(readFileSync(path, 'utf8')).toBe('user: customized\n')
      expect(statSync(path).mtimeMs).toBe(mtimeBefore)
    })

    it.runIf(process.platform !== 'win32')(
      'refuses to write through a symlink planted at the destination path',
      () => {
        mkdirSync(dir, { recursive: true })
        const secretPath = join(root, 'secret.txt')
        writeFileSync(secretPath, 'do not touch\n', 'utf8')
        const path = join(dir, 'bugfix-fast.yaml')
        symlinkSync(secretPath, path)

        const result = ensureStarterTemplate(dir)

        expect(result).toEqual({ created: false, path })
        expect(readFileSync(secretPath, 'utf8')).toBe('do not touch\n')
      }
    )

    it('succeeds when a stale temp file already exists and the destination is absent', () => {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'bugfix-fast.yaml.tmp'), 'stale from a previous crash\n', 'utf8')

      const result = ensureStarterTemplate(dir)

      expect(result).toEqual({ created: true, path: join(dir, 'bugfix-fast.yaml') })
      expect(readFileSync(result.path, 'utf8')).toBe(BUGFIX_FAST_STARTER_TEMPLATE)
    })

    it('succeeds when a stale temp file already exists and the destination is already provisioned', () => {
      mkdirSync(dir, { recursive: true })
      const path = join(dir, 'bugfix-fast.yaml')
      writeFileSync(path, 'user: customized\n', 'utf8')
      writeFileSync(join(dir, 'bugfix-fast.yaml.tmp'), 'stale from a previous crash\n', 'utf8')

      const result = ensureStarterTemplate(dir)

      expect(result).toEqual({ created: false, path })
      expect(readFileSync(path, 'utf8')).toBe('user: customized\n')
    })

    it('is a no-op on a second call once the starter already exists', () => {
      const first = ensureStarterTemplate(dir)
      const mtimeAfterFirst = statSync(first.path).mtimeMs

      const second = ensureStarterTemplate(dir)

      expect(second).toEqual({ created: false, path: first.path })
      expect(statSync(first.path).mtimeMs).toBe(mtimeAfterFirst)
    })
  })

  describe('listPipelineTemplateFiles', () => {
    it('returns an empty list when the directory does not exist', () => {
      expect(listPipelineTemplateFiles(dir)).toEqual([])
    })

    it('lists regular files directly inside the directory', () => {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'a.yaml'), 'a: 1\n', 'utf8')
      writeFileSync(join(dir, 'b.yaml'), 'b: 2\n', 'utf8')

      const files = listPipelineTemplateFiles(dir)

      expect(files.map((f) => f.basename).sort()).toEqual(['a.yaml', 'b.yaml'])
      const a = files.find((f) => f.basename === 'a.yaml')
      expect(a).toEqual({ path: join(dir, 'a.yaml'), basename: 'a.yaml', content: 'a: 1\n' })
    })

    it('does not recurse into subdirectories', () => {
      mkdirSync(join(dir, 'nested'), { recursive: true })
      writeFileSync(join(dir, 'nested', 'inner.yaml'), 'x: 1\n', 'utf8')

      expect(listPipelineTemplateFiles(dir)).toEqual([])
    })

    it.runIf(process.platform !== 'win32')(
      'includes a symlink that resolves to a file inside the directory',
      () => {
        mkdirSync(dir, { recursive: true })
        const targetPath = join(dir, 'real.yaml')
        writeFileSync(targetPath, 'real: true\n', 'utf8')
        symlinkSync(targetPath, join(dir, 'linked.yaml'))

        const files = listPipelineTemplateFiles(dir)

        expect(files.map((f) => f.basename).sort()).toEqual(['linked.yaml', 'real.yaml'])
        const linked = files.find((f) => f.basename === 'linked.yaml')
        expect(linked?.content).toBe('real: true\n')
      }
    )

    it.runIf(process.platform !== 'win32')(
      'skips a symlink that resolves outside the directory',
      () => {
        mkdirSync(dir, { recursive: true })
        const outsidePath = join(root, 'outside.yaml')
        writeFileSync(outsidePath, 'outside: true\n', 'utf8')
        symlinkSync(outsidePath, join(dir, 'escape.yaml'))
        writeFileSync(join(dir, 'kept.yaml'), 'kept: true\n', 'utf8')

        const files = listPipelineTemplateFiles(dir)

        expect(files.map((f) => f.basename)).toEqual(['kept.yaml'])
      }
    )

    it.runIf(process.platform !== 'win32')('skips a broken symlink', () => {
      mkdirSync(dir, { recursive: true })
      symlinkSync(join(dir, 'does-not-exist.yaml'), join(dir, 'broken.yaml'))
      writeFileSync(join(dir, 'kept.yaml'), 'kept: true\n', 'utf8')

      expect(listPipelineTemplateFiles(dir).map((f) => f.basename)).toEqual(['kept.yaml'])
    })

    it.runIf(process.platform !== 'win32')(
      'reads the validated target even when the entry is swapped for an escaping symlink before the read (simulated via a filesystem hook on realpathSync)',
      () => {
        mkdirSync(dir, { recursive: true })
        const insidePath = join(dir, 'real-inside.yaml')
        writeFileSync(insidePath, 'inside: true\n', 'utf8')
        const entryPath = join(dir, 'linked.yaml')
        symlinkSync(insidePath, entryPath)
        const outsidePath = join(root, 'outside.yaml')
        writeFileSync(outsidePath, 'outside: leaked\n', 'utf8')

        // fires the moment containment validation resolves the entry — the exact point
        // where a stale re-open of the entry path (rather than the validated target) races
        onRealpathSync = (path) => {
          if (path === entryPath) {
            rmSync(entryPath)
            symlinkSync(outsidePath, entryPath)
          }
        }

        let files: ReturnType<typeof listPipelineTemplateFiles>
        try {
          files = listPipelineTemplateFiles(dir)
        } finally {
          onRealpathSync = undefined
        }

        const linked = files.find((f) => f.basename === 'linked.yaml')
        expect(linked?.content).toBe('inside: true\n')
      }
    )

    it.runIf(process.platform !== 'win32')(
      'does not return outside content when a regular entry is swapped for an escaping symlink after the directory listing is taken (simulated via a filesystem hook on readdirSync)',
      () => {
        mkdirSync(dir, { recursive: true })
        const entryPath = join(dir, 'regular.yaml')
        writeFileSync(entryPath, 'inside: true\n', 'utf8')
        const outsidePath = join(root, 'outside.yaml')
        writeFileSync(outsidePath, 'outside: leaked\n', 'utf8')

        // fires right after the directory snapshot is taken — the exact point where a
        // classification captured at readdir time (regular file) could go stale before the
        // entry is individually opened
        onReaddirSync = () => {
          rmSync(entryPath)
          symlinkSync(outsidePath, entryPath)
        }

        let files: ReturnType<typeof listPipelineTemplateFiles>
        try {
          files = listPipelineTemplateFiles(dir)
        } finally {
          onReaddirSync = undefined
        }

        expect(files.find((f) => f.basename === 'regular.yaml')).toBeUndefined()
      }
    )

    it.runIf(process.platform !== 'win32' && canCreateFifo)(
      'returns without hanging when a FIFO is present, and does not list it (real mkfifo, bounded via a subprocess timeout so a regression fails the suite instead of wedging CI)',
      () => {
        mkdirSync(dir, { recursive: true })
        execFileSync('mkfifo', [join(dir, 'pipe.yaml')])
        writeFileSync(join(dir, 'kept.yaml'), 'kept: true\n', 'utf8')

        const basenames = runListPipelineTemplateFilesInSubprocess(dir)

        expect(basenames).toEqual(['kept.yaml'])
      },
      10_000
    )

    it.runIf(process.platform !== 'win32' && canCreateFifo)(
      'returns without hanging when a symlink resolves to a FIFO, and does not list it (the readdir type-filter never catches symlink entries, so this exercises O_NONBLOCK specifically)',
      () => {
        mkdirSync(dir, { recursive: true })
        const fifoPath = join(dir, 'pipe-target')
        execFileSync('mkfifo', [fifoPath])
        symlinkSync(fifoPath, join(dir, 'linked.yaml'))
        writeFileSync(join(dir, 'kept.yaml'), 'kept: true\n', 'utf8')

        const basenames = runListPipelineTemplateFilesInSubprocess(dir)

        expect(basenames).toEqual(['kept.yaml'])
      },
      10_000
    )

    it('rejects a file when dev and ino both read back as 0 rather than trusting a trivial match', () => {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'a.yaml'), 'a: 1\n', 'utf8')

      forceZeroIdentity = true
      let files: ReturnType<typeof listPipelineTemplateFiles>
      try {
        files = listPipelineTemplateFiles(dir)
      } finally {
        forceZeroIdentity = false
      }

      expect(files).toEqual([])
    })

    it('skips a file over the shared YAML size bound, keeping files within it', () => {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'huge.yaml'), 'a'.repeat(MAX_ORCA_YAML_BYTES + 1), 'utf8')
      writeFileSync(join(dir, 'kept.yaml'), 'a'.repeat(MAX_ORCA_YAML_BYTES), 'utf8')

      expect(listPipelineTemplateFiles(dir).map((f) => f.basename)).toEqual(['kept.yaml'])
    })

    it('surfaces unparsable content unchanged (parsing is the IPC layer\'s job)', () => {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'broken.yaml'), '{{{ not yaml [', 'utf8')

      const files = listPipelineTemplateFiles(dir)

      expect(files).toEqual([
        { path: join(dir, 'broken.yaml'), basename: 'broken.yaml', content: '{{{ not yaml [' }
      ])
    })
  })
})
