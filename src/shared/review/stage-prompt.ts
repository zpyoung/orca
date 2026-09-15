import type { Evidence, FindingConfidence, FindingSeverity } from './finding-schema'
import {
  REVIEW_PROFILE_ASSETS,
  REVIEW_STAGE_PROMPT_ASSETS,
  type ReviewProfileAssetKey
} from './protocol-assets'

export const REVIEW_PROMPT_STAGES = ['promote', 'refute', 'tiebreak', 'quick'] as const
export type ReviewPromptStage = (typeof REVIEW_PROMPT_STAGES)[number]

export type ClosurePriorOutput = {
  id: string
  claim: string
  category: string
  evidence: readonly Evidence[]
  remediation: string
  effective_severity: FindingSeverity
}

export type RefutePriorOutput = {
  id: string
  severity: FindingSeverity
  confidence: FindingConfidence
  category: string
  claim: string
  evidence: readonly Evidence[]
}

export type TiebreakPriorOutput = {
  id: string
  claim: string
  evidence: readonly Evidence[]
  reason: string
  counter_evidence?: readonly Evidence[]
}

type CommonStagePromptInput = {
  artifactReference: string
  criteria: string
  profile: ReviewProfileAssetKey
}

export type ComposeStagePromptInput = CommonStagePromptInput &
  (
    | {
        stage: 'promote' | 'quick'
        priorOutputs?: readonly ClosurePriorOutput[]
      }
    | {
        stage: 'refute'
        priorOutputs: readonly RefutePriorOutput[]
      }
    | {
        stage: 'tiebreak'
        priorOutputs: readonly TiebreakPriorOutput[]
      }
  )

const NO_GROUND_TRUTH = 'No additional pre-pass payload is staged in this prompt.'
const ARTIFACT_BY_REFERENCE =
  '[The captured artifact is available at the reference above and is not duplicated in this prompt.]'
const DISMISSALS_WITHHELD =
  'No dismissal payload is staged. Dismissal reasons are deliberately withheld from model stages.'

function cleanEvidence(evidence: Evidence): Evidence {
  switch (evidence.kind) {
    case 'file-line':
    case 'quote':
      return { kind: evidence.kind, ref: evidence.ref, quote: evidence.quote }
    case 'command':
      return { kind: evidence.kind, command: evidence.command, output: evidence.output }
    case 'absence':
      return {
        kind: evidence.kind,
        command: evidence.command,
        ref: evidence.ref,
        output: evidence.output
      }
    case 'prepass':
      return { kind: evidence.kind, ref: evidence.ref, output: evidence.output }
  }
}

function cleanEvidenceList(evidence: readonly Evidence[]): Evidence[] {
  return evidence.map(cleanEvidence)
}

function serializePriorOutputs(input: ComposeStagePromptInput): string {
  if (input.stage === 'promote' || input.stage === 'quick') {
    return JSON.stringify(
      (input.priorOutputs ?? []).map((output) => ({
        id: output.id,
        claim: output.claim,
        category: output.category,
        evidence: cleanEvidenceList(output.evidence),
        remediation: output.remediation,
        effective_severity: output.effective_severity
      })),
      null,
      2
    )
  }
  if (input.stage === 'refute') {
    return JSON.stringify(
      input.priorOutputs.map((output) => ({
        id: output.id,
        severity: output.severity,
        confidence: output.confidence,
        category: output.category,
        claim: output.claim,
        evidence: cleanEvidenceList(output.evidence)
      })),
      null,
      2
    )
  }
  return JSON.stringify(
    input.priorOutputs!.map((output) => ({
      id: output.id,
      claim: output.claim,
      evidence: cleanEvidenceList(output.evidence),
      reason: output.reason,
      ...(output.counter_evidence
        ? { counter_evidence: cleanEvidenceList(output.counter_evidence) }
        : {})
    })),
    null,
    2
  )
}

function interpolate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (placeholder, name: string) => {
    const value = values[name]
    if (value === undefined) {
      throw new Error(`No stage-prompt value for ${placeholder}`)
    }
    return value
  })
}

function closureSection(input: ComposeStagePromptInput, priorOutputs: string): string {
  if ((input.stage !== 'promote' && input.stage !== 'quick') || !input.priorOutputs?.length) {
    return ''
  }
  return `

## Closure-round prior protocol output

Re-check these accepted findings against the captured artifact as fixed or still open. Review the fix delta for regressions and inspect only the contract seams those fixes touched. This is protocol output, not author reasoning; dismissal reasons are withheld.

\`\`\`json
${priorOutputs}
\`\`\``
}

/** Composes a worker prompt without accepting or staging author rationale. */
export function composeStagePrompt(input: ComposeStagePromptInput): string {
  const priorOutputs = serializePriorOutputs(input)
  const assetKey = input.stage === 'quick' ? 'promote-prompt' : `${input.stage}-prompt`
  const asset = REVIEW_STAGE_PROMPT_ASSETS[assetKey]
  const quickSection = '\n## If `{{DEPTH}}` is `quick`'
  const template =
    input.stage === 'promote' ? asset.slice(0, asset.indexOf(quickSection)).trimEnd() : asset
  const prompt = interpolate(template, {
    ARTIFACT_REF: input.artifactReference,
    ARTIFACT: ARTIFACT_BY_REFERENCE,
    PROFILE: REVIEW_PROFILE_ASSETS[input.profile],
    CRITERIA: input.stage === 'promote' || input.stage === 'quick' ? input.criteria : '',
    GROUND_TRUTH: NO_GROUND_TRUTH,
    LENS: 'Open mandate.',
    DISMISSED: DISMISSALS_WITHHELD,
    DEPTH: input.stage === 'quick' ? 'quick' : 'standard',
    CLAIMS: input.stage === 'refute' ? priorOutputs : '[]',
    CONTESTED: input.stage === 'tiebreak' ? priorOutputs : '[]'
  })
  return prompt + closureSection(input, priorOutputs)
}
