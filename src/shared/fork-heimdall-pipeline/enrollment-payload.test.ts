import { describe, expect, it } from 'vitest'
import {
  PipelineEnrollmentPayloadSchema,
  PipelineEnrollmentRequestSchema
} from './enrollment-payload'

const DOCUMENT = {
  version: 1,
  id: 'bugfix',
  name: 'Bugfix',
  nodes: [{ id: 'land', type: 'land' }]
}
const PIN = {
  ref: 'bugfix',
  scope: 'repo',
  id: 'bugfix',
  contentHash: `sha256:${'a'.repeat(64)}`,
  documentVersion: 1
}
const PAYLOAD = {
  schemaVersion: 1,
  pin: PIN,
  document: DOCUMENT,
  sourceText: 'version: 1',
  runInputs: { task: 'Fix the issue' },
  workspaceKind: 'git'
}

describe('pipeline enrollment payload', () => {
  it('rejects oversized source, unsupported versions, unknown keys and malformed pins', () => {
    expect(
      PipelineEnrollmentPayloadSchema.safeParse({ ...PAYLOAD, sourceText: 'x'.repeat(262_145) })
        .success
    ).toBe(false)
    expect(
      PipelineEnrollmentPayloadSchema.safeParse({ ...PAYLOAD, schemaVersion: 2 }).success
    ).toBe(false)
    expect(PipelineEnrollmentPayloadSchema.safeParse({ ...PAYLOAD, extra: true }).success).toBe(
      false
    )
    expect(
      PipelineEnrollmentPayloadSchema.safeParse({
        ...PAYLOAD,
        pin: { ...PIN, contentHash: 'sha256:abc' }
      }).success
    ).toBe(false)
  })

  it('accepts request-only worktree settings without persisting them in the payload schema', () => {
    expect(
      PipelineEnrollmentRequestSchema.safeParse({ ...PAYLOAD, newWorktree: { name: 'x' } }).success
    ).toBe(true)
    expect(
      PipelineEnrollmentPayloadSchema.safeParse({ ...PAYLOAD, newWorktree: { name: 'x' } }).success
    ).toBe(false)
  })
})
