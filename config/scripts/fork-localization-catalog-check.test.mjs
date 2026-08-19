import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { validateForkLocalizationCatalogs } from './fork-localization-catalog-check.mjs'

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function makeProject({ sourceText, enCatalog, esCatalog = {} }) {
  const root = mkdtempSync(path.join(tmpdir(), 'orca-fork-locales-'))
  const featureDir = path.join(root, 'src/renderer/src/components/fork-chat')
  const localesDir = path.join(featureDir, 'locales')
  const upstreamLocales = path.join(root, 'src/renderer/src/i18n/locales')
  const mainDir = path.join(root, 'src/main')
  mkdirSync(localesDir, { recursive: true })
  mkdirSync(upstreamLocales, { recursive: true })
  mkdirSync(mainDir, { recursive: true })
  writeFileSync(path.join(featureDir, 'Example.tsx'), sourceText, 'utf8')
  writeFileSync(path.join(mainDir, 'empty.ts'), 'export {}\n', 'utf8')
  writeJson(path.join(localesDir, 'en.json'), enCatalog)
  writeJson(path.join(localesDir, 'es.json'), esCatalog)
  writeJson(path.join(upstreamLocales, 'en.json'), {})
  writeJson(path.join(upstreamLocales, 'es.json'), {})
  return { root, localesDir }
}

describe('fork-localization-catalog-check', () => {
  it('checks fork keys used from an upstream seam and accepts sparse translations', async () => {
    const { root } = makeProject({
      sourceText:
        "import { translate } from '@/i18n/i18n'\nexport const label = translate('components.chat.label', 'Chat {{name}}')\n",
      enCatalog: { components: { chat: { label: 'Chat {{name}}' } } },
      esCatalog: { components: { chat: { label: 'Chat {{name}}' } } }
    })
    const seam = path.join(root, 'src/renderer/src/components/Seam.tsx')
    writeFileSync(seam, "translate('components.chat.label', 'Chat {{name}}')\n", 'utf8')

    await expect(validateForkLocalizationCatalogs(root, { fix: false })).resolves.toBe(0)
  })

  it('rejects target-only keys and interpolation mismatches with the upstream parity rules', async () => {
    const { root } = makeProject({
      sourceText: "translate('components.chat.label', 'Chat {{name}}')\n",
      enCatalog: { components: { chat: { label: 'Chat {{name}}' } } },
      esCatalog: { components: { chat: { label: 'Chat {{wrong}}', stale: 'Stale' } } }
    })

    await expect(validateForkLocalizationCatalogs(root, { fix: false })).resolves.toBe(1)
  })

  it('adds a missing English key with its literal fallback to the owning fork catalog', async () => {
    const { root, localesDir } = makeProject({
      sourceText: "translate('components.chat.label', 'Chat')\n",
      enCatalog: {},
      esCatalog: {}
    })

    await expect(validateForkLocalizationCatalogs(root, { fix: true })).resolves.toBe(0)
    await expect(
      import('node:fs/promises').then(({ readFile }) =>
        readFile(path.join(localesDir, 'en.json'), 'utf8')
      )
    ).resolves.toContain('"label": "Chat"')
  })
})
