import { describe, expect, it } from 'vitest'
import {
  PipelineEnsureTrackedRequestSchema,
  PipelineListRequestSchema,
  PipelinePersonalRequestSchema,
  PipelineResolveRequestSchema,
  PipelineRunViewRequestSchema,
  PipelineWorkspaceSelectorSchema
} from './rpc-schemas'

const workspace = { repoId: 'repo-1', worktreeId: null }
const target = { watcherId: 'watcher-1', connectionId: null, pairingRevision: null }

describe('pipeline RPC request schemas', () => {
  it('requires a complete workspace selector', () => {
    expect(PipelineWorkspaceSelectorSchema.safeParse({ worktreeId: null }).success).toBe(false)
    expect(PipelineWorkspaceSelectorSchema.safeParse({ ...workspace, extra: true }).success).toBe(
      false
    )
  })

  it('rejects unknown keys on every request family and personal operation', () => {
    expect(PipelineListRequestSchema.safeParse({ workspace, extra: true }).success).toBe(false)
    expect(
      PipelineResolveRequestSchema.safeParse({ workspace, ref: 'bugfix', extra: true }).success
    ).toBe(false)
    expect(
      PipelinePersonalRequestSchema.safeParse({ op: 'read', id: 'bugfix', extra: true }).success
    ).toBe(false)
    expect(
      PipelinePersonalRequestSchema.safeParse({
        op: 'write',
        id: 'bugfix',
        yamlText: 'version: 1',
        extra: true
      }).success
    ).toBe(false)
    expect(PipelinePersonalRequestSchema.safeParse({ op: 'list', extra: true }).success).toBe(false)
    expect(
      PipelinePersonalRequestSchema.safeParse({ op: 'stat', id: 'bugfix', extra: true }).success
    ).toBe(false)
    expect(
      PipelinePersonalRequestSchema.safeParse({ op: 'delete', id: 'bugfix', extra: true }).success
    ).toBe(false)
    expect(
      PipelineEnsureTrackedRequestSchema.safeParse({
        workspace,
        pipelineId: 'bugfix',
        extra: true
      }).success
    ).toBe(false)
    expect(PipelineRunViewRequestSchema.safeParse({ target, extra: true }).success).toBe(false)
  })

  it('accepts explicit personal deletion and one-click re-inclusion intents', () => {
    expect(PipelinePersonalRequestSchema.parse({ op: 'delete', id: 'bugfix' })).toEqual({
      op: 'delete',
      id: 'bugfix'
    })
    expect(
      PipelineEnsureTrackedRequestSchema.parse({ workspace, pipelineId: 'bugfix', reinclude: true })
    ).toEqual({ workspace, pipelineId: 'bugfix', reinclude: true })
  })
})
