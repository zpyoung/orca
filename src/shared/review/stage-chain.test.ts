import { describe, expect, it } from 'vitest'
import {
  assertChainAgreement,
  canonicalJson,
  createGateChain,
  createManifestChain,
  digestPayload,
  linkStageChain,
  mintResolveChain,
  StageChainError
} from './stage-chain'

describe('stage chain', () => {
  const resolve = {
    target: 'WORKTREE',
    chain: mintResolveChain('run-1', 'artifact-1')
  }

  it('matches the pinned Python canonical digest, including non-ASCII strings', () => {
    const payload = { z: 'é😀', a: [1, true, null, { b: 'x', a: 2 }] }
    expect(canonicalJson(payload)).toBe(
      '{"a":[1,true,null,{"a":2,"b":"x"}],"z":"\\u00e9\\ud83d\\ude00"}'
    )
    expect(digestPayload(payload)).toBe(
      '753dfd6943d19ff4eb4ecf30b00f5e98d91b28e6bc050b5d586b23224e6a1a75'
    )
  })

  it('links allowed steps to the entire predecessor payload digest', () => {
    const claims = linkStageChain(resolve, 'standard', 'claims', 2)
    expect(claims).toMatchObject({
      run_id: 'run-1',
      artifact_hash: 'artifact-1',
      step: 'claims',
      predecessor: digestPayload(resolve),
      attempt: 2
    })
  })

  it('distinguishes deep refute and tiebreak merges', () => {
    const claimsPayload = { findings: [], chain: linkStageChain(resolve, 'deep', 'claims') }
    const refutePayload = {
      findings: [],
      chain: linkStageChain(claimsPayload, 'deep', 'merge', 1, 'refute')
    }
    expect(linkStageChain(refutePayload, 'deep', 'merge', 1, 'tiebreak')).toMatchObject({
      step: 'merge',
      stage: 'tiebreak'
    })
    expect(() => linkStageChain(refutePayload, 'deep', 'merge', 1, 'refute')).toThrow(
      StageChainError
    )
  })

  it('binds quick gate and manifest inputs to one run', () => {
    const prepass = { chain: linkStageChain(resolve, 'quick', 'prepass') }
    const model = { chain: linkStageChain(resolve, 'quick', 'select-model') }
    const gate = { chain: createGateChain({ depth: 'quick', resolve, prepass, model }) }
    expect(gate.chain.step).toBe('gate')
    expect(
      createManifestChain({ depth: 'quick', resolve, prepass, model, gate, contestedCount: 0 }).step
    ).toBe('manifest')
    expect(() =>
      createManifestChain({ depth: 'quick', resolve, prepass, model, gate, contestedCount: 1 })
    ).toThrow('unsettled')
  })

  it('refuses mixed runs and mixed artifacts', () => {
    const prepass = { chain: { ...resolve.chain, step: 'prepass', predecessor: 'x' } }
    const model = {
      chain: { ...resolve.chain, run_id: 'run-2', step: 'select-model', predecessor: 'x' }
    }
    expect(() =>
      assertChainAgreement([
        { label: 'prepass', payload: prepass, expectedStep: 'prepass' },
        { label: 'model', payload: model, expectedStep: 'select-model' }
      ])
    ).toThrow('different runs')
  })
})
