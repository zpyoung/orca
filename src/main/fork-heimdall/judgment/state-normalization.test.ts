import { describe, expect, it } from 'vitest'
import {
  expandJudgmentState,
  isNormalizedJudgmentState,
  normalizeJudgmentState,
  type NormalizedJudgmentState
} from './state-normalization'
import { stableJson } from './state-projection'

function referencedIds(value: unknown, ids = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const child of value) {
      referencedIds(child, ids)
    }
    return ids
  }
  if (value === null || typeof value !== 'object') {
    return ids
  }
  const entries = Object.entries(value)
  if (entries.length === 1 && entries[0]![0] === '$ref' && typeof entries[0]![1] === 'string') {
    ids.add(entries[0]![1])
    return ids
  }
  for (const [, child] of entries) {
    referencedIds(child, ids)
  }
  return ids
}

describe('judgment shared-string normalization', () => {
  it('round trips exact projected JSON through refs and hostile literal control objects', () => {
    const repeated = '界\\"\nworker-authored text '.repeat(40)
    const nested = {
      constructor: repeated,
      $ref: repeated,
      missing: undefined
    }
    const state = {
      contentIdentity: repeated,
      objective: {
        array: [repeated, null, { value: repeated }],
        hostileLiteral: { $literal: { child: repeated } },
        hostileRef: { $ref: repeated },
        nested,
        singleton: 'a-single-value'
      },
      ledger: { reports: [{ body: repeated }, { body: repeated }] }
    }
    const canonical = stableJson(state)
    const result = normalizeJudgmentState(state)

    expect(result.normalization).not.toBeNull()
    expect(isNormalizedJudgmentState(result.state)).toBe(true)
    expect(result.state.contentIdentity).toBe(repeated)
    expect(result.serializedState).toBe(JSON.stringify(result.state))
    expect(result.serializedBytes).toBe(Buffer.byteLength(result.serializedState, 'utf8'))
    expect(result.serializedBytes).toBeLessThan(Buffer.byteLength(canonical, 'utf8'))
    expect(expandJudgmentState(result.state)).toEqual(JSON.parse(canonical))
    expect((expandJudgmentState(result.state) as typeof state).objective.nested.constructor).toBe(
      repeated
    )
  })

  it('allocates deterministic IDs from every original string but exposes only reachable definitions', () => {
    const repeated = 'zz-shared-long-value-'.repeat(30)
    const state = {
      contentIdentity: 'content',
      objective: {
        before: 'aa-singleton',
        early: 'bb-singleton',
        first: repeated,
        middle: 'mm-singleton',
        late: 'yy-singleton',
        second: repeated
      },
      ledger: { third: repeated }
    }
    const first = normalizeJudgmentState(state)
    const second = normalizeJudgmentState(state)
    expect(first.serializedState).toBe(second.serializedState)
    expect(isNormalizedJudgmentState(first.state)).toBe(true)

    const normalized = first.state as NormalizedJudgmentState
    expect(normalized.normalization.strings).toEqual({ s5: repeated })
    expect(referencedIds({ objective: normalized.objective, ledger: normalized.ledger })).toEqual(
      new Set(['s5'])
    )
    expect(Object.keys(normalized.normalization.strings)).toEqual([
      ...referencedIds({ objective: normalized.objective, ledger: normalized.ledger })
    ])
  })

  it('keeps short and no-savings states in the legacy shape and canonical identity', () => {
    const state = {
      contentIdentity: 'same-root',
      objective: { one: 'x', two: 'x', omitted: undefined },
      ledger: { values: ['x', 'x'] }
    }
    const canonical = stableJson(state)
    const result = normalizeJudgmentState(state)

    expect(result.normalization).toBeNull()
    expect(isNormalizedJudgmentState(result.state)).toBe(false)
    expect(result.serializedState).toBe(canonical)
    expect(result.state).toEqual(JSON.parse(canonical))
  })

  it('keeps encoded prefix sizes monotone through literal escapes and ref-to-inline cutovers', () => {
    const repeated = 'history text with unicode 界 and escapes \\\\ " '.repeat(30)
    const history = Array.from({ length: 12 }, (_, index) => ({
      body: repeated,
      collision: index % 2 === 0 ? { $ref: repeated } : { $literal: repeated },
      id: `history-${index}`
    }))
    let previousBytes = Number.MAX_SAFE_INTEGER
    for (let omitted = 0; omitted <= history.length; omitted += 1) {
      const state = {
        contentIdentity: 'content',
        objective: { current: repeated },
        ledger: { reports: history.slice(omitted) },
        truncation: { omitted: { reports: omitted }, policy: 'oldest-history-first', version: 1 }
      }
      const canonical = stableJson(state)
      const result = normalizeJudgmentState(state)
      expect(expandJudgmentState(result.state)).toEqual(JSON.parse(canonical))
      expect(result.serializedBytes).toBeLessThanOrEqual(previousBytes)
      if (isNormalizedJudgmentState(result.state)) {
        const ids = referencedIds({
          objective: result.state.objective,
          ledger: result.state.ledger,
          truncation: result.state.truncation
        })
        expect(new Set(Object.keys(result.state.normalization.strings))).toEqual(ids)
      }
      previousBytes = result.serializedBytes
    }
  })

  it('preserves an own __proto__ key without mutating object prototypes', () => {
    const repeated = 'prototype-looking data '.repeat(60)
    const objective = Object.fromEntries([
      ['__proto__', { $ref: 's0' }],
      ['other', { $ref: 's0' }]
    ])
    const normalized: NormalizedJudgmentState = {
      contentIdentity: 'content',
      objective,
      ledger: {},
      normalization: { format: 'shared-strings-v1', strings: { s0: repeated } }
    }
    const expanded = expandJudgmentState<{
      contentIdentity: string
      objective: Record<string, unknown>
      ledger: unknown
    }>(normalized)
    expect(Object.hasOwn(expanded.objective, '__proto__')).toBe(true)
    expect(expanded.objective.__proto__).toBe(repeated)
    expect(Object.getPrototypeOf(expanded.objective)).toBe(Object.prototype)
  })

  it('rejects dangling refs instead of silently changing data', () => {
    const malformed: NormalizedJudgmentState = {
      contentIdentity: 'content',
      objective: { value: { $ref: 's9' } },
      ledger: {},
      normalization: { format: 'shared-strings-v1', strings: {} }
    }
    expect(() => expandJudgmentState(malformed)).toThrow('dangling string reference')
  })
})
