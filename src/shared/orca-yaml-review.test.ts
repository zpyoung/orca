import { describe, expect, it } from 'vitest'

import { MAX_ORCA_YAML_COLLECTION_ENTRIES } from './orca-yaml-file-limit'
import { parseOrcaYaml } from './orca-yaml'

describe('orca.yaml review defaults', () => {
  it('parses ordered checks and generated output exclusions', () => {
    expect(
      parseOrcaYaml(`
review:
  checks:
    - pnpm test
    - pnpm lint
  generatedOutputs:
    - coverage/**
    - .pytest_cache/**
`)
    ).toEqual({
      scripts: {},
      review: {
        checks: ['pnpm test', 'pnpm lint'],
        generatedOutputs: ['coverage/**', '.pytest_cache/**']
      }
    })
  })

  it('drops blank and non-string entries without reordering valid entries', () => {
    expect(
      parseOrcaYaml(`
review:
  checks: [' first ', '', 3, second]
`)
    ).toMatchObject({ review: { checks: ['first', 'second'] } })
  })

  it('ignores an over-sized review collection', () => {
    const checks = Array.from(
      { length: MAX_ORCA_YAML_COLLECTION_ENTRIES + 1 },
      (_, index) => `check-${index}`
    )
    expect(
      parseOrcaYaml(`review:
  checks:
${checks.map((check) => `    - ${check}`).join('\n')}`)
    ).toBeNull()
  })
})
