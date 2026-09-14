import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { KernelAction, WatcherKind } from '../../shared/fork-heimdall/kind-contract'
import { WatcherKindRegistry } from './registry'

function kind(id: 'hosted-review' | 'objective'): WatcherKind<unknown, KernelAction> {
  return {
    id,
    displayName: id,
    describeEnrollment: () => id,
    enrollmentPayloadSchema: z.unknown(),
    authorizeEnrollment: vi.fn(),
    read: vi.fn(),
    describeSnapshot: vi.fn(),
    decide: vi.fn(),
    execute: vi.fn(),
    resolveOutcome: vi.fn()
  }
}

describe('WatcherKindRegistry', () => {
  it('throws instead of replacing a duplicate kind id', () => {
    const registry = new WatcherKindRegistry()
    const first = kind('hosted-review')
    registry.register(first)

    expect(() => registry.register(kind('hosted-review'))).toThrow(/duplicate.*hosted-review/i)
    expect(registry.get('hosted-review')).toBe(first)
  })

  it('returns null for an unregistered kind so enrollment can refuse it', () => {
    const registry = new WatcherKindRegistry()
    expect(registry.get('objective')).toBeNull()
  })
})
