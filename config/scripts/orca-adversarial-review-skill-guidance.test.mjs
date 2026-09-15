import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const projectDir = resolve(import.meta.dirname, '../..')
const guidePath = join(projectDir, 'skill-guides', 'orca-adversarial-review.md')
const stubPath = join(projectDir, 'skills', 'orca-adversarial-review', 'SKILL.md')

function read(path) {
  return readFileSync(path, 'utf8')
}

describe('orca-adversarial-review skill guidance', () => {
  it('routes discovery through the safe version-matched CLI guide', () => {
    for (const content of [read(guidePath), read(stubPath)]) {
      expect(content).toContain("Drive Orca's CLI")
      expect(content).toContain('Requires an Orca workspace')
      expect(content).toContain('ORCA_CLI_COMMAND')
      expect(content).toContain('orca-dev')
      expect(content).toContain('orca-ide')
      expect(content).toContain('GNOME')
      expect(content).toContain('screen reader')
      expect(content).toContain('ORCA skills get orca-adversarial-review')
      expect(content).not.toMatch(/^orca /mu)
    }
  })

  it('documents every depth shape and the deterministic chain', () => {
    const guide = read(guidePath)
    const normalizedGuide = guide.replace(/\s+/gu, ' ')

    expect(guide).toContain('### Quick')
    expect(guide).toContain('### Standard')
    expect(guide).toContain('### Deep')
    expect(guide).toContain('ORCA review claims')
    expect(guide).toContain('ORCA review merge')
    expect(guide).toContain('ORCA review gate')
    expect(guide).toContain('ORCA review manifest')
    expect(normalizedGuide).toContain('Never call `manifest` while contested findings remain')
  })

  it('keeps dispatch failure and asymmetric-staging rules explicit', () => {
    const guide = read(guidePath)

    expect(guide).toContain('Retry the same stage once')
    expect(guide).toContain('--retry-of <dispatch-id>')
    expect(guide).toContain('move to the next available reviewer')
    expect(guide).toContain('ORCA review run-fail')
    expect(guide).toContain('## Never stage to a reviewer')
    expect(guide).toContain('commit messages')
    expect(guide).toContain('design rationale')
    expect(guide).toContain('dismissed-finding reasons')
    expect(guide).toContain('previous model reasoning')
    expect(guide).toContain('instructions to edit/write/apply patches')
  })
})
