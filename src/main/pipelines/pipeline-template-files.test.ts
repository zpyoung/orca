import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import type { PathLike, PathOrFileDescriptor } from 'node:fs'
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
let onWriteFileSync: ((path: PathOrFileDescriptor) => void) | undefined
let onRealpathSync: ((path: PathLike) => void) | undefined

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return {
    ...actual,
    writeFileSync: ((...args: Parameters<typeof actual.writeFileSync>) => {
      const result = actual.writeFileSync(...args)
      onWriteFileSync?.(args[0])
      return result
    }) as typeof actual.writeFileSync,
    realpathSync: ((...args: Parameters<typeof actual.realpathSync>) => {
      const result = actual.realpathSync(...args)
      onRealpathSync?.(args[0])
      return result
    }) as typeof actual.realpathSync
  }
})

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
      'refuses to write through a symlink planted at the predictable temp path',
      () => {
        mkdirSync(dir, { recursive: true })
        const secretPath = join(root, 'secret.txt')
        writeFileSync(secretPath, 'do not touch\n', 'utf8')
        symlinkSync(secretPath, join(dir, 'bugfix-fast.yaml.tmp'))

        expect(() => ensureStarterTemplate(dir)).toThrow()

        expect(readFileSync(secretPath, 'utf8')).toBe('do not touch\n')
        expect(existsSync(join(dir, 'bugfix-fast.yaml'))).toBe(false)
      }
    )

    it('does not clobber a user template created in the window between the absence check and placement', () => {
      const path = join(dir, 'bugfix-fast.yaml')
      const raceContent = 'user: created-mid-flight\n'
      // simulates a concurrent writer landing the destination right after our temp copy is
      // ready but before it gets placed — the exact window a check-then-rename can race
      onWriteFileSync = (writtenPath) => {
        if (String(writtenPath).endsWith('.tmp')) {
          writeFileSync(path, raceContent, 'utf8')
        }
      }

      let result: { created: boolean; path: string }
      try {
        result = ensureStarterTemplate(dir)
      } finally {
        onWriteFileSync = undefined
      }

      expect(result).toEqual({ created: false, path })
      expect(readFileSync(path, 'utf8')).toBe(raceContent)
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
