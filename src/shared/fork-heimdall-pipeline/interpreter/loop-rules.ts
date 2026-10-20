import type { PipelineDocument, PipelineLoopNode } from '../document-schema'
import { getAttemptResolution, getLatestAttempts } from '../../fork-heimdall/ledger-queries'
import type { WatcherLedger } from '../../fork-heimdall/ledger-types'
import { parsePipelineNodeEvidenceKey, type PipelineChoice } from '../choice-types'
import { pipelineNodeIdentity } from './node-instance'
import { pipelineOutputReference, type PipelineOutputValues } from './decision-rules'
import { decodePipelineVerdict, type PipelineVerdictDecision } from './verdict-output'

export type LoopRoundFacts = { round: number; extraRounds: number }
export type LoopVerdict = PipelineVerdictDecision | null

function hasLandedRoundControl(ledger: WatcherLedger, payload: unknown, loopId: string): boolean {
  if (
    payload === null ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    !('loopId' in payload) ||
    payload.loopId !== loopId ||
    !('epoch' in payload) ||
    typeof payload.epoch !== 'number' ||
    !Number.isInteger(payload.epoch) ||
    !('round' in payload) ||
    typeof payload.round !== 'number' ||
    !Number.isInteger(payload.round) ||
    !('extraRounds' in payload) ||
    typeof payload.extraRounds !== 'number' ||
    !Number.isInteger(payload.extraRounds) ||
    !('attemptId' in payload) ||
    typeof payload.attemptId !== 'string' ||
    !('attemptFingerprint' in payload) ||
    typeof payload.attemptFingerprint !== 'string'
  ) {
    return false
  }
  const attempt = getLatestAttempts(ledger).find(
    (candidate) =>
      candidate.attemptId === payload.attemptId &&
      candidate.fingerprint === payload.attemptFingerprint &&
      candidate.action.kind === 'pipeline-apply-choice' &&
      candidate.state === 'settled' &&
      (getAttemptResolution(ledger, candidate.attemptId)?.effect ?? candidate.effect) === 'landed'
  )
  if (
    attempt === undefined ||
    !('choice' in attempt.action) ||
    attempt.action.choice !== 'one-more-round'
  ) {
    return false
  }
  const identity = pipelineNodeIdentity(attempt.action)
  const parsedKey = parsePipelineNodeEvidenceKey(attempt.action.evidenceKey)
  return (
    identity?.instanceId === loopId &&
    identity.epoch === payload.epoch &&
    parsedKey?.instanceId === loopId &&
    parsedKey.epoch === payload.epoch &&
    (parsedKey.cause === 'loop-max' || parsedKey.cause === 'loop-escalate')
  )
}

export function loopRoundFacts(ledger: WatcherLedger, loopId: string): LoopRoundFacts {
  let result: LoopRoundFacts = { round: 1, extraRounds: 0 }
  for (const entry of ledger.entries) {
    if (
      entry.kind !== 'evidence' ||
      entry.evidenceKind !== 'pipeline-loop-round' ||
      !hasLandedRoundControl(ledger, entry.payload, loopId)
    ) {
      continue
    }
    const payload = entry.payload
    if (
      payload === null ||
      typeof payload !== 'object' ||
      Array.isArray(payload) ||
      !('loopId' in payload) ||
      payload.loopId !== loopId ||
      !('round' in payload) ||
      !('extraRounds' in payload)
    ) {
      continue
    }
    const round = payload.round
    const extraRounds = payload.extraRounds
    if (
      typeof round === 'number' &&
      Number.isInteger(round) &&
      round > 0 &&
      typeof extraRounds === 'number' &&
      Number.isInteger(extraRounds) &&
      extraRounds >= 0
    ) {
      result = { round, extraRounds }
    }
  }
  return result
}

export function loopMaximumRounds(loop: PipelineLoopNode, ledger: WatcherLedger): number {
  return loop.maxRounds + loopRoundFacts(ledger, loop.id).extraRounds
}

export function loopVerdict(loop: PipelineLoopNode, outputs: PipelineOutputValues): LoopVerdict {
  const reference = pipelineOutputReference(loop.until)
  if (reference === null) {
    return null
  }
  return decodePipelineVerdict(outputs[reference.nodeId]?.[reference.name])?.verdict ?? null
}

export function loopAnswerChoice(
  choice: PipelineChoice,
  currentRound: number,
  maximumRounds: number
): 'exit' | 'next-round' | 'abort' | null {
  if (choice === 'accept') {
    return 'exit'
  }
  if (choice === 'one-more-round' && currentRound === maximumRounds) {
    return 'next-round'
  }
  return choice === 'abort' ? 'abort' : null
}

export function loopReentryNode(document: PipelineDocument, loop: PipelineLoopNode): string {
  const body = new Set(loop.body)
  for (const nodeId of loop.body) {
    const node = document.nodes.find((candidate) => candidate.id === nodeId)
    if (node?.after?.every((edge) => !body.has(typeof edge === 'string' ? edge : edge.node))) {
      return nodeId
    }
  }
  return loop.body[0] ?? loop.id
}
