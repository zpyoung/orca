import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_ORCA_YAML_BYTES } from '../../shared/orca-yaml-file-limit'
import { BUGFIX_FAST_STARTER_TEMPLATE } from './pipeline-starter-template'
import {
  ensureStarterTemplate,
  getPipelineTemplatesDir,
  listPipelineTemplateFiles
} from './pipeline-template-files'

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
