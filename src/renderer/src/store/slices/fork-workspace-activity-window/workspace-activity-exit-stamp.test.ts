import { describe, expect, it } from 'vitest'
import type { AppState } from '../../types'
import type { Worktree } from '../../../../../shared/worktree/types'
import { workspaceActivityExitPatchForActivation } from './workspace-activity-exit-stamp'

// The patch keys the stamp; these read it back the way the sidebar's visit-key lookup does.
function stampedKeys(patch: { workspaceActivityExitStamps?: Record<string, number> }): string[] {
  return Object.keys(patch.workspaceActivityExitStamps ?? {})
}

function createState(rows: Worktree[]): AppState {
  return {
    worktreesByRepo: { repo1: rows },
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    workspaceActivityExitStamps: {}
  } as unknown as AppState
}

const localRow = { id: 'workspace', repoId: 'repo1', hostId: undefined } as unknown as Worktree
const remoteRow = { id: 'workspace', repoId: 'repo1', hostId: 'ssh:hostA' } as unknown as Worktree
const nextRow = { id: 'next', repoId: 'repo1', hostId: undefined } as unknown as Worktree

describe('workspaceActivityExitPatchForActivation', () => {
  it('stamps a local row unqualified even though the activation records a host', () => {
    const patch = workspaceActivityExitPatchForActivation(
      createState([localRow, nextRow]),
      'workspace',
      'local',
      'next',
      'local'
    )
    expect(stampedKeys(patch)).toEqual(['workspace'])
  })

  it('stamps a hosted row under its own host', () => {
    const patch = workspaceActivityExitPatchForActivation(
      createState([remoteRow, nextRow]),
      'workspace',
      'ssh:hostA',
      'next',
      'local'
    )
    expect(stampedKeys(patch)).toEqual(['ssh:hostA|workspace'])
  })

  it('falls back to the activation host for a row that is not a worktree', () => {
    const patch = workspaceActivityExitPatchForActivation(
      createState([nextRow]),
      'folder:abc',
      'ssh:hostB',
      'next',
      'local'
    )
    expect(stampedKeys(patch)).toEqual(['ssh:hostB|folder:abc'])
  })

  it('does not stamp when the activation stays on the same workspace', () => {
    const patch = workspaceActivityExitPatchForActivation(
      createState([remoteRow]),
      'workspace',
      'ssh:hostA',
      'workspace',
      'ssh:hostA'
    )
    expect(patch).toEqual({})
  })

  it('does not stamp when the activation names a workspace that is not known', () => {
    const patch = workspaceActivityExitPatchForActivation(
      createState([localRow]),
      'workspace',
      'local',
      'missing',
      'local'
    )
    expect(patch).toEqual({})
  })

  it('stamps the departing workspace when the activation clears the selection', () => {
    const patch = workspaceActivityExitPatchForActivation(
      createState([localRow]),
      'workspace',
      'local',
      null,
      null
    )
    expect(stampedKeys(patch)).toEqual(['workspace'])
  })
})
