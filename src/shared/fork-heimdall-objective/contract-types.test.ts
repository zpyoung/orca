import { describe, expect, it } from 'vitest'
import {
  ObjectiveCapabilitiesSchema,
  ObjectiveEnrollmentPayloadSchema,
  objectiveCapabilityModes,
  type ObjectiveEnrollmentPayload
} from './contract-types'

function payload(overrides: Partial<ObjectiveEnrollmentPayload> = {}): ObjectiveEnrollmentPayload {
  return {
    objectiveText: 'Implement the objective',
    tier: 'standard',
    landingBar: 'files-on-disk',
    maxConcurrency: 1,
    workspaceKind: 'git',
    writeTerritory: ['src/**'],
    roleAgents: {},
    sitterOverrides: {},
    ...overrides
  }
}

describe('objective enrollment payload', () => {
  it('accepts the three review tiers and keeps the complete landing ladder', () => {
    for (const tier of ['express', 'standard', 'full'] as const) {
      expect(ObjectiveEnrollmentPayloadSchema.parse(payload({ tier })).tier).toBe(tier)
    }
    for (const landingBar of [
      'files-on-disk',
      'committed-local-branch',
      'pushed-ref',
      'hosted-review',
      'merged'
    ] as const) {
      expect(ObjectiveEnrollmentPayloadSchema.parse(payload({ landingBar })).landingBar).toBe(
        landingBar
      )
    }
  })

  it('rejects unknown fields and unbounded objective text', () => {
    expect(
      ObjectiveEnrollmentPayloadSchema.safeParse({ ...payload(), ignored: true }).success
    ).toBe(false)
    expect(
      ObjectiveEnrollmentPayloadSchema.safeParse(payload({ objectiveText: 'x'.repeat(16_385) }))
        .success
    ).toBe(false)
  })

  it.each([
    '../src/**',
    '/tmp/**',
    'C:/repo/**',
    '.git/**',
    '.orca/**',
    '**',
    '*/**',
    'src/../secrets/**',
    'src\\**'
  ])('rejects territory that can escape or address protected state: %s', (territory) => {
    expect(
      ObjectiveEnrollmentPayloadSchema.safeParse(payload({ writeTerritory: [territory] })).success
    ).toBe(false)
  })

  it('rejects duplicate or excessive territory entries', () => {
    expect(
      ObjectiveEnrollmentPayloadSchema.safeParse(payload({ writeTerritory: ['src/**', 'src/**'] }))
        .success
    ).toBe(false)
    expect(
      ObjectiveEnrollmentPayloadSchema.safeParse(
        payload({ writeTerritory: Array.from({ length: 65 }, (_, index) => `src/${index}/**`) })
      ).success
    ).toBe(false)
  })

  it('derives the exact default capability modes from the landing bar', () => {
    expect(objectiveCapabilityModes('files-on-disk')).toEqual({
      plan: 'gated',
      implement: 'on',
      review: 'on',
      check: 'on',
      land: 'on'
    })
    expect(objectiveCapabilityModes('merged').land).toBe('gated')
  })

  it('requires exactly the five objective capability keys', () => {
    const capabilities = objectiveCapabilityModes('files-on-disk')
    expect(ObjectiveCapabilitiesSchema.safeParse(capabilities).success).toBe(true)
    expect(
      ObjectiveCapabilitiesSchema.safeParse({
        plan: 'gated',
        implement: 'on',
        review: 'on',
        check: 'on'
      }).success
    ).toBe(false)
    expect(
      ObjectiveCapabilitiesSchema.safeParse({ ...capabilities, unexpected: 'on' }).success
    ).toBe(false)
  })
})
