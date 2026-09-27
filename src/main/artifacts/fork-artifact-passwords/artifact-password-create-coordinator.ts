import { randomUUID } from 'node:crypto'
import type { ArtifactListItem, ArtifactWriteRequest } from '../../../shared/artifacts'
import { OrcaCloudRequestError } from '../../orca-profiles/profile-cloud-client'
import {
  artifactRequest,
  artifactWriteBody,
  type ArtifactWriteBody
} from '../artifact-cloud-request'
import {
  getArtifactCreateIntent,
  getOrCreateArtifactCreateIntent,
  removeArtifactCreateIntent
} from '../artifact-create-intent-store'
import {
  getArtifactShareRecord,
  saveArtifactShareRecord,
  type ArtifactShareScope
} from '../artifact-share-record-store'
import type {
  ArtifactPasswordCredentials,
  ArtifactPasswordRecordStore
} from './artifact-password-record-store'

type ArtifactPasswordCreateAuthContext = {
  profileId: string
  scope: ArtifactShareScope
  assertCurrent: () => void
}

type ArtifactCreateResponse = ArtifactListItem & { editToken: string }

function protectedIntentSourceKey(sourceKey: string): string {
  return JSON.stringify(['artifact-password', sourceKey])
}

function writeBodiesMatch(left: ArtifactWriteBody, right: ArtifactWriteBody): boolean {
  return (
    left.content === right.content &&
    left.contentType === right.contentType &&
    left.fileName === right.fileName &&
    left.title === right.title
  )
}

function discardsCreateIntent(error: unknown): boolean {
  return (
    error instanceof OrcaCloudRequestError &&
    error.statusCode >= 400 &&
    error.statusCode < 500 &&
    ![408, 409, 425, 429].includes(error.statusCode)
  )
}

function credentialsFromItem(
  item: ArtifactListItem,
  editToken: string
): ArtifactPasswordCredentials {
  return {
    slug: item.artifact.slug,
    editToken,
    shareUrl: item.shareUrl,
    expiresAt: item.artifact.expiresAt
  }
}

export async function deleteProtectedArtifact(
  apiUrl: string,
  token: string,
  slug: string,
  editToken: string
): Promise<void> {
  try {
    await artifactRequest<void>(apiUrl, token, `/${slug}`, {
      method: 'DELETE',
      editToken
    })
  } catch (error) {
    if (
      !(error instanceof OrcaCloudRequestError) ||
      error.statusCode !== 404 ||
      error.errorCode !== 'artifact_not_found'
    ) {
      throw error
    }
  }
}

/** Recovers idempotent protected creates without losing staged password state. */
export class ArtifactPasswordCreateCoordinator {
  constructor(
    private readonly userDataPath: string,
    private readonly records: ArtifactPasswordRecordStore
  ) {}

  async recoverCommitted(
    request: ArtifactWriteRequest,
    token: string,
    apiUrl: string,
    auth: ArtifactPasswordCreateAuthContext
  ): Promise<ArtifactListItem | null> {
    auth.assertCurrent()
    const current = this.records.getCurrent(auth.profileId, request.sourceKey, auth.scope)
    if (!current?.completedCreateIntentId) {
      return null
    }
    const intentSourceKey = protectedIntentSourceKey(request.sourceKey)
    const intent = getArtifactCreateIntent(
      auth.profileId,
      this.userDataPath,
      intentSourceKey,
      auth.scope
    )
    // the surviving intent is the only evidence of an unfinished create; completedCreateIntentId
    // outlives it, so gating on that alone leaves this replay armed for every later share
    if (!intent || intent.idempotencyKey !== current.completedCreateIntentId) {
      return null
    }
    const share = getArtifactShareRecord(
      auth.profileId,
      this.userDataPath,
      request.sourceKey,
      auth.scope
    )
    if (!share || share.slug !== current.slug) {
      throw new Error('The protected artifact share record is unavailable for recovery.')
    }
    const body = artifactWriteBody(request)
    const item = await artifactRequest<ArtifactListItem>(apiUrl, token, `/${current.slug}`, {
      ...(writeBodiesMatch(intent.body, body) ? {} : { method: 'PUT', body }),
      editToken: share.editToken
    })
    auth.assertCurrent()
    removeArtifactCreateIntent(
      auth.profileId,
      this.userDataPath,
      intentSourceKey,
      auth.scope,
      intent.idempotencyKey
    )
    this.records.rebindCurrent(
      auth.profileId,
      request.sourceKey,
      auth.scope,
      item.artifact.slug,
      item.artifact.expiresAt
    )
    return item
  }

  async create(
    request: ArtifactWriteRequest,
    token: string,
    apiUrl: string,
    auth: ArtifactPasswordCreateAuthContext,
    idempotencyKey: string
  ): Promise<ArtifactListItem> {
    auth.assertCurrent()
    const intentSourceKey = protectedIntentSourceKey(request.sourceKey)
    const pending = this.records.getPending(auth.profileId, request.sourceKey, auth.scope)
    if (!pending) {
      throw new Error('Protected artifact create state is missing.')
    }
    const recovered = pending.created
    let intent = getArtifactCreateIntent(
      auth.profileId,
      this.userDataPath,
      intentSourceKey,
      auth.scope
    )
    const current = this.records.getCurrent(auth.profileId, request.sourceKey, auth.scope)
    if (intent && current?.completedCreateIntentId === intent.idempotencyKey) {
      removeArtifactCreateIntent(
        auth.profileId,
        this.userDataPath,
        intentSourceKey,
        auth.scope,
        intent.idempotencyKey
      )
      intent = null
    }
    if (recovered) {
      return this.finish(request, token, apiUrl, auth, recovered, intent)
    }
    const createIntent =
      intent ??
      getOrCreateArtifactCreateIntent(
        auth.profileId,
        this.userDataPath,
        intentSourceKey,
        auth.scope,
        idempotencyKey || randomUUID(),
        artifactWriteBody(request)
      )
    let response: ArtifactCreateResponse
    try {
      response = await artifactRequest<ArtifactCreateResponse>(apiUrl, token, '', {
        method: 'POST',
        body: createIntent.body,
        idempotencyKey: createIntent.idempotencyKey
      })
    } catch (error) {
      if (!intent && discardsCreateIntent(error)) {
        removeArtifactCreateIntent(
          auth.profileId,
          this.userDataPath,
          intentSourceKey,
          auth.scope,
          createIntent.idempotencyKey
        )
        this.records.clearPending(auth.profileId, request.sourceKey, auth.scope)
      }
      throw error
    }
    auth.assertCurrent()
    const credentials = credentialsFromItem(response, response.editToken)
    this.records.markCreated(auth.profileId, request.sourceKey, auth.scope, credentials)
    return this.finish(request, token, apiUrl, auth, credentials, createIntent, response)
  }

  private async finish(
    request: ArtifactWriteRequest,
    token: string,
    apiUrl: string,
    auth: ArtifactPasswordCreateAuthContext,
    credentials: ArtifactPasswordCredentials,
    intent: ReturnType<typeof getArtifactCreateIntent>,
    response?: ArtifactListItem
  ): Promise<ArtifactListItem> {
    let item =
      response ??
      (await artifactRequest<ArtifactListItem>(apiUrl, token, `/${credentials.slug}`, {
        editToken: credentials.editToken
      }))
    if (intent && !writeBodiesMatch(intent.body, artifactWriteBody(request))) {
      item = await artifactRequest<ArtifactListItem>(apiUrl, token, `/${credentials.slug}`, {
        method: 'PUT',
        editToken: credentials.editToken,
        body: artifactWriteBody(request)
      })
      credentials = credentialsFromItem(item, credentials.editToken)
      this.records.markCreated(auth.profileId, request.sourceKey, auth.scope, credentials)
    }
    auth.assertCurrent()
    saveArtifactShareRecord(auth.profileId, this.userDataPath, request.sourceKey, {
      slug: credentials.slug,
      editToken: credentials.editToken,
      shareUrl: credentials.shareUrl,
      expiresAt: credentials.expiresAt,
      ...auth.scope
    })
    this.records.finalizePending(
      auth.profileId,
      request.sourceKey,
      auth.scope,
      credentials,
      intent?.idempotencyKey
    )
    if (intent) {
      removeArtifactCreateIntent(
        auth.profileId,
        this.userDataPath,
        protectedIntentSourceKey(request.sourceKey),
        auth.scope,
        intent.idempotencyKey
      )
    }
    return item
  }
}
