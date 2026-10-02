import { describe, expect, it } from 'vitest'
import { PipelineLayoutSchema, PipelineLayoutWriteSchema } from './layout-schema'

describe('pipeline layout schemas', () => {
  it('reads forward-compatible layout properties while the writer rejects them', () => {
    const layout = { version: 1, nodes: { a: { x: 1, y: 2 } }, extra: true }
    expect(PipelineLayoutSchema.safeParse(layout).success).toBe(true)
    expect(PipelineLayoutWriteSchema.safeParse(layout).success).toBe(false)
  })

  it('requires valid positions and a supported file version', () => {
    expect(
      PipelineLayoutWriteSchema.safeParse({ version: 1, nodes: { a: { x: 0, y: 0 } } }).success
    ).toBe(true)
    expect(PipelineLayoutWriteSchema.safeParse({ version: 2, nodes: {} }).success).toBe(false)
    expect(
      PipelineLayoutWriteSchema.safeParse({ version: 1, nodes: { 'Bad ID': { x: 0, y: 0 } } })
        .success
    ).toBe(false)
  })
})
