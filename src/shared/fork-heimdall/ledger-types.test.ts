import { describe, expect, it } from 'vitest'
import { AttemptEntrySchema, AttemptResolvedEntrySchema } from './ledger-types'

const BASE_ACTION = {
  kind: 'dispatch-node',
  capability: 'implement',
  visibility: 'local' as const,
  contentIdentity: 'content-1',
  evidenceKey: 'revision-1:core'
}

describe('AttemptEntrySchema failureClass', () => {
  it('parses an existing-shape row that predates failureClass', () => {
    const row = {
      kind: 'attempt' as const,
      eventId: 'event-1',
      watcherId: 'watcher-1',
      atMs: 1,
      origin: 'owner' as const,
      class: 'fact' as const,
      attemptId: 'attempt-1',
      fingerprint: 'fingerprint-1',
      action: BASE_ACTION,
      state: 'settled' as const,
      effect: 'not-landed' as const
    }
    expect(AttemptEntrySchema.safeParse(row).success).toBe(true)
  })

  it('parses a row carrying a failure class', () => {
    const row = {
      kind: 'attempt' as const,
      eventId: 'event-2',
      watcherId: 'watcher-1',
      atMs: 1,
      origin: 'owner' as const,
      class: 'fact' as const,
      attemptId: 'attempt-2',
      fingerprint: 'fingerprint-2',
      action: BASE_ACTION,
      state: 'settled' as const,
      effect: 'not-landed' as const,
      failureClass: 'environment' as const
    }
    expect(AttemptEntrySchema.safeParse(row).success).toBe(true)
  })

  it('rejects a failure class outside the taxonomy', () => {
    const row = {
      kind: 'attempt' as const,
      eventId: 'event-3',
      watcherId: 'watcher-1',
      atMs: 1,
      origin: 'owner' as const,
      class: 'fact' as const,
      attemptId: 'attempt-3',
      fingerprint: 'fingerprint-3',
      action: BASE_ACTION,
      state: 'settled' as const,
      effect: 'not-landed' as const,
      failureClass: 'operator-error'
    }
    expect(AttemptEntrySchema.safeParse(row).success).toBe(false)
  })
})

describe('AttemptResolvedEntrySchema failureClass', () => {
  it('parses an existing-shape row that predates failureClass', () => {
    const row = {
      kind: 'attempt-resolved' as const,
      eventId: 'event-4',
      watcherId: 'watcher-1',
      atMs: 1,
      origin: 'owner' as const,
      class: 'fact' as const,
      attemptId: 'attempt-1',
      effect: 'not-landed' as const,
      evidence: { reason: 'worker failed' }
    }
    expect(AttemptResolvedEntrySchema.safeParse(row).success).toBe(true)
  })

  it('parses a row carrying a failure class', () => {
    const row = {
      kind: 'attempt-resolved' as const,
      eventId: 'event-5',
      watcherId: 'watcher-1',
      atMs: 1,
      origin: 'owner' as const,
      class: 'fact' as const,
      attemptId: 'attempt-1',
      effect: 'not-landed' as const,
      failureClass: 'infra' as const,
      evidence: { reason: 'worker exited' }
    }
    expect(AttemptResolvedEntrySchema.safeParse(row).success).toBe(true)
  })

  it('parses bounded report validation provenance while preserving old rows', () => {
    const row = {
      kind: 'attempt-resolved' as const,
      eventId: 'event-6',
      watcherId: 'watcher-1',
      atMs: 1,
      origin: 'owner' as const,
      class: 'fact' as const,
      attemptId: 'attempt-1',
      effect: 'not-landed' as const,
      failureClass: 'criteria' as const,
      reportValidation: {
        status: 'rejected' as const,
        code: 'malformed' as const,
        role: 'implementer' as const,
        dispatchId: 'dispatch-1',
        taskKey: 'core',
        reportPath: '/workspace/report.json',
        detail: 'summary: expected string',
        reportedFiles: ['src/core.ts'],
        observedFiles: [],
        hostVerifiable: true
      },
      evidence: { summary: 'objective' }
    }
    expect(AttemptResolvedEntrySchema.safeParse(row).success).toBe(true)
  })
})
