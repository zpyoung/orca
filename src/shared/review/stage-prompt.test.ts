import { describe, expect, it } from 'vitest'
import { REVIEW_PROFILE_ASSETS } from './protocol-assets'
import {
  composeStagePrompt,
  type ClosurePriorOutput,
  type RefutePriorOutput,
  type TiebreakPriorOutput
} from './stage-prompt'

const artifactReference = '.orca-review/runs/run-1/artifact/diff.patch'
const criteria = 'Keep the retry contract intact — criteria stay verbatim.'

const closureOutput: ClosurePriorOutput = {
  id: 'F1',
  claim: 'The retry path drops the original error.',
  category: 'missing-error-path',
  evidence: [{ kind: 'file-line', ref: 'src/retry.ts:10', quote: 'return null' }],
  remediation: 'Return the original error.',
  effective_severity: 'HIGH'
}

const refuteOutput: RefutePriorOutput = {
  id: 'F1',
  severity: 'HIGH',
  confidence: 'MEDIUM',
  category: 'missing-error-path',
  claim: 'The retry path drops the original error.',
  evidence: [{ kind: 'file-line', ref: 'src/retry.ts:10', quote: 'return null' }]
}

const tiebreakOutput: TiebreakPriorOutput = {
  id: 'F1',
  claim: 'The retry path drops the original error.',
  evidence: [{ kind: 'file-line', ref: 'src/retry.ts:10', quote: 'return null' }],
  reason: 'The surrounding guard may make the path unreachable.',
  counter_evidence: [{ kind: 'quote', ref: 'src/retry.ts:2', quote: 'if (ready)' }]
}

function promptFor(stage: 'promote' | 'refute' | 'tiebreak' | 'quick'): string {
  const common = { artifactReference, criteria, profile: 'code-diff' as const }
  if (stage === 'refute') {
    return composeStagePrompt({ ...common, stage, priorOutputs: [refuteOutput] })
  }
  if (stage === 'tiebreak') {
    return composeStagePrompt({ ...common, stage, priorOutputs: [tiebreakOutput] })
  }
  return composeStagePrompt({ ...common, stage })
}

describe('composeStagePrompt', () => {
  it.each([
    ['promote', '# Promote Prompt — stage 1'],
    ['refute', '# Refute Prompt — stage 2'],
    ['tiebreak', '# Tiebreak Prompt — stage 3'],
    ['quick', '# Promote Prompt — stage 1']
  ] as const)('uses the pinned %s asset and profile', (stage, heading) => {
    const prompt = promptFor(stage)

    expect(prompt).toContain(heading)
    expect(prompt).toContain(REVIEW_PROFILE_ASSETS['code-diff'])
    expect(prompt).toContain(artifactReference)
    expect(prompt).not.toMatch(/\{\{[A-Z_]+\}\}/)
  })

  it('stages criteria verbatim only in recall-shaped prompts', () => {
    expect(promptFor('promote')).toContain(criteria)
    expect(promptFor('quick')).toContain(criteria)
    expect(promptFor('refute')).not.toContain(criteria)
    expect(promptFor('tiebreak')).not.toContain(criteria)
  })

  it('activates pinned self-refutation only for quick', () => {
    expect(promptFor('quick')).toContain('At `quick` depth there is no second dispatch')
    expect(promptFor('promote')).not.toContain('At `quick` depth there is no second dispatch')
  })

  it('stages closure outputs through the narrow protocol projection', () => {
    const injected = {
      ...closureOutput,
      reason: 'SECRET DISMISSAL RATIONALE',
      ruling_reason: 'SECRET RULING RATIONALE',
      dismissal_reason: 'SECRET AUTHOR RATIONALE',
      dismissed: true,
      evidence: [
        {
          ...closureOutput.evidence[0],
          dismissal_reason: 'SECRET NESTED RATIONALE'
        } as unknown as (typeof closureOutput.evidence)[number]
      ]
    } as ClosurePriorOutput

    const prompt = composeStagePrompt({
      artifactReference,
      criteria,
      profile: 'code-diff',
      stage: 'promote',
      priorOutputs: [injected]
    })

    expect(prompt).toContain('## Closure-round prior protocol output')
    expect(prompt).toContain('"id": "F1"')
    expect(prompt).toContain('"category": "missing-error-path"')
    expect(prompt).toContain('"remediation": "Return the original error."')
    expect(prompt).toContain('"effective_severity": "HIGH"')
    expect(prompt).not.toContain('SECRET')
    expect(prompt).not.toContain('ruling_reason')
    expect(prompt).not.toContain('dismissal_reason')
    expect(prompt).not.toContain('"dismissed"')
  })

  it('does not add a closure section to a discovery prompt', () => {
    expect(promptFor('promote')).not.toContain('## Closure-round prior protocol output')
  })

  it('projects refute claims to the six fields required by the pinned contract', () => {
    const prompt = composeStagePrompt({
      artifactReference,
      criteria,
      profile: 'plan',
      stage: 'refute',
      priorOutputs: [{ ...refuteOutput, remediation: 'do not stage' } as RefutePriorOutput]
    })

    expect(prompt).toContain('"confidence": "MEDIUM"')
    expect(prompt).toContain('"category": "missing-error-path"')
    expect(prompt).not.toContain('do not stage')
  })

  it('keeps the refuter record needed by tiebreak but strips extra fields', () => {
    const prompt = composeStagePrompt({
      artifactReference,
      criteria,
      profile: 'spec-design',
      stage: 'tiebreak',
      priorOutputs: [
        { ...tiebreakOutput, dismissal_reason: 'SECRET AUTHOR RATIONALE' } as TiebreakPriorOutput
      ]
    })

    expect(prompt).toContain(tiebreakOutput.reason)
    expect(prompt).toContain('"counter_evidence"')
    expect(prompt).not.toContain('SECRET')
  })
})
