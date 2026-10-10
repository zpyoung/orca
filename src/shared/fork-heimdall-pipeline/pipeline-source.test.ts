import { describe, expect, it } from 'vitest'
import { PipelineSourceSnapshotSchema, PipelineSourceTextSchema } from './pipeline-source'

describe('pipeline source snapshots', () => {
  it('enforces the UTF-8 YAML byte limit and a strict source-only envelope', () => {
    expect(PipelineSourceTextSchema.safeParse(`${'x'.repeat(262_142)}é`).success).toBe(true)
    expect(PipelineSourceTextSchema.safeParse(`${'x'.repeat(262_143)}é`).success).toBe(false)
    expect(PipelineSourceSnapshotSchema.safeParse({ sourceText: 'version: 1' }).success).toBe(true)
    expect(
      PipelineSourceSnapshotSchema.safeParse({ sourceText: 'version: 1', document: {} }).success
    ).toBe(false)
  })
})
