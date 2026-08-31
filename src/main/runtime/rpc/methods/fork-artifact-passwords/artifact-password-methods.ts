import { z } from 'zod'
import type { ArtifactWriteRequest } from '../../../../../shared/artifacts'
import { defineMethod, type RpcAnyMethod } from '../../core'
import { SourceRequest, WriteRequest } from '../artifacts'

function protectedRequest(
  params: ArtifactWriteRequest,
  mode: 'protect' | 'rotate' | 'remove'
): ArtifactWriteRequest {
  return { ...params, protection: { mode } }
}

const ProtectedWriteRequest = WriteRequest.and(
  z.object({ protection: z.never().optional() }).strip()
)

function assertLocalPasswordRequest(clientKind: 'mobile' | 'runtime' | undefined): void {
  if (clientKind !== undefined) {
    throw new Error(
      'Artifact password operations are available only to local Orca desktop and CLI callers.'
    )
  }
}

export const ARTIFACT_PASSWORD_METHODS: readonly RpcAnyMethod[] = [
  defineMethod({
    name: 'artifacts.shareProtected',
    params: ProtectedWriteRequest,
    handler: (params, { runtime, clientKind }) => {
      assertLocalPasswordRequest(clientKind)
      return runtime.shareArtifact(protectedRequest(params, 'protect'))
    }
  }),
  defineMethod({
    name: 'artifacts.publishProtected',
    params: ProtectedWriteRequest,
    handler: (params, { runtime, clientKind }) => {
      assertLocalPasswordRequest(clientKind)
      return runtime.publishArtifact(protectedRequest(params, 'protect'))
    }
  }),
  defineMethod({
    name: 'artifacts.rotateProtection',
    params: ProtectedWriteRequest,
    handler: (params, { runtime, clientKind }) => {
      assertLocalPasswordRequest(clientKind)
      return runtime.publishArtifact(protectedRequest(params, 'rotate'))
    }
  }),
  defineMethod({
    name: 'artifacts.removeProtection',
    params: ProtectedWriteRequest,
    handler: (params, { runtime, clientKind }) => {
      assertLocalPasswordRequest(clientKind)
      return runtime.publishArtifact(protectedRequest(params, 'remove'))
    }
  }),
  defineMethod({
    name: 'artifacts.revealPassphrase',
    params: SourceRequest,
    handler: (params, { runtime, clientKind }) => {
      assertLocalPasswordRequest(clientKind)
      return runtime.getPublishedArtifactLink({ ...params, revealPassphrase: true })
    }
  })
]
