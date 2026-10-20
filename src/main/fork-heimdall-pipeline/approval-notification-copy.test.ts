import { describe, expect, it } from 'vitest'
import { WatcherEnrollmentSchema } from '../../shared/fork-heimdall/watcher-types'
import { makePipelineNodeEvidenceKey } from '../../shared/fork-heimdall-pipeline/choice-types'
import { PipelineEnrollmentPayloadSchema } from '../../shared/fork-heimdall-pipeline/enrollment-payload'
import { approvalNotificationCopy } from './approval-notification-copy'

const payload = PipelineEnrollmentPayloadSchema.parse({
  schemaVersion: 1,
  pin: {
    ref: 'repo:bugfix',
    scope: 'repo',
    id: 'bugfix',
    contentHash: `sha256:${'0'.repeat(64)}`,
    documentVersion: 1
  },
  document: {
    version: 1,
    id: 'bugfix',
    name: 'Bugfix (fast)',
    nodes: [
      { id: 'build', type: 'agent', label: 'Build', harness: 'claude', prompt: 'Fix the issue' },
      { id: 'approve', type: 'gate', label: 'Approve plan' }
    ]
  },
  sourceText: '',
  runInputs: { task: 'Fix the issue' },
  workspaceKind: 'git'
})

const pipelineEnrollment = WatcherEnrollmentSchema.parse({
  watcherId: 'watcher-1',
  kind: 'pipeline',
  workspaceKey: 'local::/workspace',
  executionHostId: 'local',
  repoId: 'repo-1',
  worktreeId: null,
  workspacePath: '/workspace',
  schedulerOwner: 'local_host_service',
  enabled: true,
  paused: false,
  commandRevision: 0,
  capabilities: { gate: 'on' },
  budget: { wallClockActiveMs: null, turns: null },
  kindPayload: payload,
  coordinatorIdentity: { handle: 'coordinator', paneKey: 'pane-1' },
  orchestrationRunId: null,
  createdAtMs: 0,
  terminalAtMs: null
})

describe('approvalNotificationCopy', () => {
  it('names the pipeline and gate in human approval notifications', () => {
    expect(
      approvalNotificationCopy(pipelineEnrollment, {
        kind: 'pipeline-pass-gate',
        evidenceKey: makePipelineNodeEvidenceKey({
          instanceId: 'approve',
          epoch: 0,
          attempt: 0,
          cause: 'gate'
        })
      })
    ).toEqual({
      title: 'Bugfix (fast) is waiting at Approve plan',
      body: 'Approve, send back or abort in Heimdall.'
    })
  })

  it('names the pipeline node and cause in engine-choice notifications', () => {
    expect(
      approvalNotificationCopy(pipelineEnrollment, {
        kind: 'pipeline-apply-choice',
        evidenceKey: makePipelineNodeEvidenceKey({
          instanceId: 'build[task-a]',
          epoch: 0,
          attempt: 1,
          cause: 'retries-exhausted'
        })
      })
    ).toEqual({
      title: 'Bugfix (fast) needs a decision',
      body: 'Build: retries-exhausted'
    })
  })

  it('keeps objective strings and falls back for malformed pipeline payloads', () => {
    const objectiveEnrollment = WatcherEnrollmentSchema.parse({
      ...pipelineEnrollment,
      kind: 'objective',
      kindPayload: { label: 'Objective' }
    })
    const action = { kind: 'apply-review-fix', evidenceKey: 'review-1' }

    expect(approvalNotificationCopy(objectiveEnrollment, action)).toEqual({
      title: 'Watcher approval requested',
      body: 'apply-review-fix is waiting for approval'
    })
    expect(
      approvalNotificationCopy(
        WatcherEnrollmentSchema.parse({ ...pipelineEnrollment, kindPayload: { schemaVersion: 2 } }),
        { kind: 'pipeline-pass-gate', evidenceKey: 'invalid' }
      )
    ).toEqual({
      title: 'Watcher approval requested',
      body: 'pipeline-pass-gate is waiting for approval'
    })
  })
})
