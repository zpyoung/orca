import { describe, expect, it } from 'vitest'
import {
  OBJECTIVE_ALL_WORKSPACE_PATHS_GLOB,
  OBJECTIVE_EXISTING_PLAN_MAX_LENGTH,
  OBJECTIVE_TEXT_MAX_LENGTH,
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

  it('keeps lane enrollment optional for older payloads and preserves an explicit opt-out', () => {
    expect(ObjectiveEnrollmentPayloadSchema.parse(payload()).lanesEnabled).toBeUndefined()
    expect(
      ObjectiveEnrollmentPayloadSchema.parse(payload({ lanesEnabled: false })).lanesEnabled
    ).toBe(false)
  })

  it('accepts the canonical whole-workspace territory', () => {
    expect(
      ObjectiveEnrollmentPayloadSchema.parse(
        payload({ writeTerritory: [OBJECTIVE_ALL_WORKSPACE_PATHS_GLOB] })
      ).writeTerritory
    ).toEqual([OBJECTIVE_ALL_WORKSPACE_PATHS_GLOB])
  })

  it('canonicalizes and bounds the optional existing plan', () => {
    expect(
      ObjectiveEnrollmentPayloadSchema.parse(
        payload({ existingPlan: ' \n# Existing plan\n\n- Keep this task. \n' })
      ).existingPlan
    ).toBe('# Existing plan\n\n- Keep this task.')
    expect(
      ObjectiveEnrollmentPayloadSchema.safeParse(payload({ existingPlan: ' \n\t ' })).success
    ).toBe(false)
    expect(
      ObjectiveEnrollmentPayloadSchema.safeParse(
        payload({ existingPlan: 'x'.repeat(OBJECTIVE_EXISTING_PLAN_MAX_LENGTH + 1) })
      ).success
    ).toBe(false)
  })

  it('rejects unknown fields and enforces objective text in UTF-16 code units', () => {
    expect(
      ObjectiveEnrollmentPayloadSchema.safeParse({ ...payload(), ignored: true }).success
    ).toBe(false)

    const multibyteObjective = '界'.repeat(OBJECTIVE_TEXT_MAX_LENGTH)
    expect(Buffer.byteLength(multibyteObjective, 'utf8')).toBeGreaterThan(OBJECTIVE_TEXT_MAX_LENGTH)
    expect(
      ObjectiveEnrollmentPayloadSchema.safeParse(payload({ objectiveText: multibyteObjective }))
        .success
    ).toBe(true)
    expect(
      ObjectiveEnrollmentPayloadSchema.safeParse(
        payload({ objectiveText: `${multibyteObjective}界` })
      ).success
    ).toBe(false)
  })

  it.each([
    '../src/**',
    '/tmp/**',
    'C:/repo/**',
    '.git/**',
    '.orca/**',
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

  it('parses an enrollment with no owner-intervention key exactly as it did before that key existed', () => {
    const capabilities = objectiveCapabilityModes('files-on-disk')
    const parsed = ObjectiveCapabilitiesSchema.parse(capabilities)
    expect(parsed).toEqual(capabilities)
    expect('owner-intervention' in parsed).toBe(false)
  })

  it('parses an owner-intervention key the kernel stamps onto an owner-configured enrollment', () => {
    const capabilities = {
      ...objectiveCapabilityModes('files-on-disk'),
      'owner-intervention': 'on' as const
    }
    const parsed = ObjectiveCapabilitiesSchema.safeParse(capabilities)
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data['owner-intervention']).toBe('on')
  })
})
