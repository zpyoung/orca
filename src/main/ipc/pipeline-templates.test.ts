import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { getPipelineTemplatesDir } from '../pipelines/pipeline-template-files'

const { handleMock } = vi.hoisted(() => ({ handleMock: vi.fn() }))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock }
}))

import { registerPipelineTemplateHandlers } from './pipeline-templates'

function getHandler(channel: string): (...args: unknown[]) => unknown {
  const call = handleMock.mock.calls.find(([registeredChannel]) => registeredChannel === channel)
  if (!call) {
    throw new Error(`No handler registered for ${channel}`)
  }
  return call[1] as (...args: unknown[]) => unknown
}

const VALID_TEMPLATE = `version: 1
name: extra
description: An extra template.
defaults:
  harness: claude
nodes:
  - id: only
    prompt: Do the thing with {{input}}.
`

describe('registerPipelineTemplateHandlers', () => {
  let home: string
  let dir: string

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'orca-pipeline-ipc-'))
    dir = getPipelineTemplatesDir(home)
    registerPipelineTemplateHandlers(home)
  })

  beforeEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  afterAll(() => {
    rmSync(home, { recursive: true, force: true })
  })

  describe('registration lifecycle', () => {
    it('registering a second time does not throw and leaves working handlers', async () => {
      const callCountBefore = handleMock.mock.calls.length

      expect(() => registerPipelineTemplateHandlers(home)).not.toThrow()

      expect(handleMock.mock.calls.length).toBe(callCountBefore)
      const result = (await getHandler('pipelines:list-templates')()) as unknown[]
      expect(result).toEqual([
        {
          basename: 'bugfix-fast.yaml',
          name: 'bugfix-fast',
          description: 'Reproduce a bug, fix it, prove the fix, open a PR. No human gates.',
          needsNewerOrca: false
        }
      ])
    })
  })

  describe('pipelines:list-templates', () => {
    it('provisions the starter template on first call and lists it parsed', async () => {
      const result = (await getHandler('pipelines:list-templates')()) as unknown[]

      expect(result).toEqual([
        {
          basename: 'bugfix-fast.yaml',
          name: 'bugfix-fast',
          description: 'Reproduce a bug, fix it, prove the fix, open a PR. No human gates.',
          needsNewerOrca: false
        }
      ])
    })

    it('does not overwrite an existing starter and lists other templates too', async () => {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'bugfix-fast.yaml'), 'user: customized\n', 'utf8')
      writeFileSync(join(dir, 'extra.yaml'), VALID_TEMPLATE, 'utf8')

      const result = (await getHandler('pipelines:list-templates')()) as {
        basename: string
        error?: unknown
      }[]

      const starter = result.find((entry) => entry.basename === 'bugfix-fast.yaml')
      expect(starter?.error).toBeDefined()
      const extra = result.find((entry) => entry.basename === 'extra.yaml')
      expect(extra).toEqual({
        basename: 'extra.yaml',
        name: 'extra',
        description: 'An extra template.',
        needsNewerOrca: false
      })
    })

    it('lists a file that fails to parse with its error, never replacing it', async () => {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'broken.yaml'), '{{{ not yaml [', 'utf8')

      const result = (await getHandler('pipelines:list-templates')()) as {
        basename: string
        error?: { rule: number }
      }[]

      const broken = result.find((entry) => entry.basename === 'broken.yaml')
      expect(broken?.error).toBeDefined()
      expect(typeof broken?.error?.rule).toBe('number')
    })
  })

  describe('pipelines:resolve-template', () => {
    const invalidBasenames = [
      '../escape.yaml',
      'sub/dir.yaml',
      'sub\\dir.yaml',
      '/etc/passwd.yaml',
      'C:\\Windows\\evil.yaml',
      '\\\\server\\share\\evil.yaml',
      '..',
      'noextension',
      'notes.txt'
    ]

    it.each(invalidBasenames)('rejects %s before touching disk', async (basename) => {
      const result = await getHandler('pipelines:resolve-template')(null, {
        basename,
        inputText: 'x'
      })

      expect(result).toEqual({ ok: false, error: { kind: 'invalid_basename' } })
    })

    it('reports template_not_found for a syntactically valid basename absent from the listing', async () => {
      mkdirSync(dir, { recursive: true })

      const result = await getHandler('pipelines:resolve-template')(null, {
        basename: 'missing.yaml',
        inputText: 'x'
      })

      expect(result).toEqual({ ok: false, error: { kind: 'template_not_found' } })
    })

    it('reports template_error with the structural failure detail', async () => {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'broken.yaml'), '{{{ not yaml [', 'utf8')

      const result = (await getHandler('pipelines:resolve-template')(null, {
        basename: 'broken.yaml',
        inputText: 'x'
      })) as { ok: false; error: { kind: string; detail?: { rule: number } } }

      expect(result.ok).toBe(false)
      expect(result.error.kind).toBe('template_error')
      expect(typeof result.error.detail?.rule).toBe('number')
    })

    it('resolves a valid template by exact basename match, substituting {{input}}', async () => {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'extra.yaml'), VALID_TEMPLATE, 'utf8')

      const result = (await getHandler('pipelines:resolve-template')(null, {
        basename: 'extra.yaml',
        inputText: 'bug report text'
      })) as { ok: true; definition: { templateName: string; nodes: { prompt: string }[] } }

      expect(result.ok).toBe(true)
      expect(result.definition.templateName).toBe('extra')
      expect(result.definition.nodes[0].prompt).toBe('Do the thing with bug report text.')
    })

    it('never matches a basename via path construction, only exact enumerated equality', async () => {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'extra.yaml'), VALID_TEMPLATE, 'utf8')

      const result = await getHandler('pipelines:resolve-template')(null, {
        basename: './extra.yaml',
        inputText: 'x'
      })

      expect(result).toEqual({ ok: false, error: { kind: 'invalid_basename' } })
    })

    const malformedArgs = [
      ['null args', null],
      ['missing basename', { inputText: 'x' }],
      ['non-string basename', { basename: 42, inputText: 'x' }],
      ['non-string inputText', { basename: 'extra.yaml', inputText: 42 }]
    ] as const

    it.each(malformedArgs)('rejects %s before touching disk', async (_label, args) => {
      const result = await getHandler('pipelines:resolve-template')(null, args)

      expect(result).toEqual({ ok: false, error: { kind: 'invalid_basename' } })
    })
  })
})
