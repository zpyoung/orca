import { describe, expect, it } from 'vitest'
import { acceptsPredecessor, manifestAcceptsGate, RUN_SHAPE_TABLE } from './run-shape'

describe('run-shape DAG table', () => {
  it('covers exactly the three pinned depths', () => {
    expect(Object.keys(RUN_SHAPE_TABLE).sort()).toEqual(['deep', 'quick', 'standard'])
  })

  it('resolve mints the run id and accepts no predecessor', () => {
    expect(acceptsPredecessor('quick', 'resolve', null)).toBe(true)
    expect(acceptsPredecessor('quick', 'resolve', 'select-model')).toBe(false)
  })
})

describe('quick depth', () => {
  it('accepts the common prefix through gate off select-model', () => {
    expect(acceptsPredecessor('quick', 'prepass', 'resolve')).toBe(true)
    expect(acceptsPredecessor('quick', 'select-model', 'resolve')).toBe(true)
    expect(acceptsPredecessor('quick', 'gate', 'select-model')).toBe(true)
    expect(acceptsPredecessor('quick', 'manifest', 'gate')).toBe(true)
  })

  it('has no claims/merge stage to skip into or out of', () => {
    expect(acceptsPredecessor('quick', 'claims', 'resolve')).toBe(false)
    expect(acceptsPredecessor('quick', 'gate', 'claims')).toBe(false)
  })

  it('rejects an out-of-order predecessor', () => {
    expect(acceptsPredecessor('quick', 'prepass', 'gate')).toBe(false)
  })
})

describe('standard depth', () => {
  it('walks claims -> merge -> gate -> manifest', () => {
    expect(acceptsPredecessor('standard', 'claims', 'resolve')).toBe(true)
    expect(acceptsPredecessor('standard', 'merge', 'claims')).toBe(true)
    expect(acceptsPredecessor('standard', 'gate', 'merge')).toBe(true)
    expect(acceptsPredecessor('standard', 'manifest', 'gate')).toBe(true)
  })

  it('rejects skipping merge straight from claims to gate', () => {
    expect(acceptsPredecessor('standard', 'gate', 'claims')).toBe(false)
  })

  it('rejects an out-of-order predecessor', () => {
    expect(acceptsPredecessor('standard', 'select-model', 'claims')).toBe(false)
  })

  it('has no tiebreak round: merge never chains off merge, gate.final does not exist', () => {
    expect(acceptsPredecessor('standard', 'merge', 'merge')).toBe(false)
    expect(acceptsPredecessor('standard', 'gate.final', 'merge')).toBe(false)
  })
})

describe('deep depth', () => {
  it('walks claims -> merge -> gate, then a tiebreak round through gate.final', () => {
    expect(acceptsPredecessor('deep', 'claims', 'resolve')).toBe(true)
    expect(acceptsPredecessor('deep', 'merge', 'claims')).toBe(true)
    expect(acceptsPredecessor('deep', 'gate', 'merge')).toBe(true)
    // the tiebreak merge chains off the refute merge's own output, not off gate
    expect(acceptsPredecessor('deep', 'merge', 'merge')).toBe(true)
    expect(acceptsPredecessor('deep', 'gate.final', 'merge')).toBe(true)
    expect(acceptsPredecessor('deep', 'manifest', 'gate.final')).toBe(true)
  })

  it('accepts manifest straight off gate when nothing was contested', () => {
    expect(acceptsPredecessor('deep', 'manifest', 'gate')).toBe(true)
  })

  it('rejects skipping merge straight from claims to gate', () => {
    expect(acceptsPredecessor('deep', 'gate', 'claims')).toBe(false)
  })

  it('rejects an out-of-order predecessor', () => {
    expect(acceptsPredecessor('deep', 'prepass', 'merge')).toBe(false)
  })
})

describe('manifestAcceptsGate', () => {
  it('accepts a gate or gate.final with nothing contested', () => {
    expect(manifestAcceptsGate('deep', 'gate', 0)).toBe(true)
    expect(manifestAcceptsGate('deep', 'gate.final', 0)).toBe(true)
    expect(manifestAcceptsGate('standard', 'gate', 0)).toBe(true)
    expect(manifestAcceptsGate('quick', 'gate', 0)).toBe(true)
  })

  it('refuses any gate payload with a non-empty contested[], even though the step matches', () => {
    expect(manifestAcceptsGate('deep', 'gate', 2)).toBe(false)
    expect(manifestAcceptsGate('deep', 'gate.final', 1)).toBe(false)
  })

  it('refuses a step manifest never accepts, regardless of contested count', () => {
    expect(manifestAcceptsGate('standard', 'claims', 0)).toBe(false)
  })
})
