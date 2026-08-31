import { randomUUID } from 'node:crypto'
import type { ArtifactListItem, ArtifactWriteRequest } from '../../../shared/artifacts'
import { OrcaCloudRequestError } from '../../orca-profiles/profile-cloud-client'
import { artifactRequest, artifactWriteBody } from '../artifact-cloud-request'
import {
  getArtifactCreateIntent,
  getOrCreateArtifactCreateIntent,
  removeArtifactCreateIntent,
  type ArtifactCreateIntent
} from '../artifact-create-intent-store'
import type { ArtifactPublisher } from '../artifact-publisher'
import {
  getArtifactShareRecord,
  refreshArtifactShareRecordExpiration,
  removeArtifactShareRecords,
  type ArtifactShareScope
} from '../artifact-share-record-store'
import type { ArtifactPasswordRecordStore } from './artifact-password-record-store'

type ArtifactPasswordRemovalAuth = {
  profileId: string
  scope: ArtifactShareScope
  assertCurrent: () => void
}

function removalIntentSourceKey(sourceKey: string): string {
  return JSON.stringify(['artifact-password-removal', sourceKey])
}

function requestFromIntent(sourceKey: string, intent: ArtifactCreateIntent): ArtifactWriteRequest {
  return { sourceKey, ...intent.body }
}

/** Replays public conversion before discarding a protected artifact secret. */
export class ArtifactPasswordRemovalCoordinator {
  constructor(
    private readonly userDataPath: string,
    private readonly records: ArtifactPasswordRecordStore
  ) {}

  hasPending(sourceKey: string, auth: ArtifactPasswordRemovalAuth): boolean {
    return Boolean(
      getArtifactCreateIntent(
        auth.profileId,
        this.userDataPath,
        removalIntentSourceKey(sourceKey),
        auth.scope
      )
    )
  }

  stage(
    request: ArtifactWriteRequest,
    auth: ArtifactPasswordRemovalAuth
  ): { intent: ArtifactCreateIntent; request: ArtifactWriteRequest } {
    const { protection: _protection, ...plainRequest } = request
    const intent = getOrCreateArtifactCreateIntent(
      auth.profileId,
      this.userDataPath,
      removalIntentSourceKey(request.sourceKey),
      auth.scope,
      randomUUID(),
      artifactWriteBody(plainRequest)
    )
    this.records.markRemoval(auth.profileId, request.sourceKey, auth.scope, 'pending')
    return { intent, request: requestFromIntent(request.sourceKey, intent) }
  }

  complete(
    sourceKey: string,
    auth: ArtifactPasswordRemovalAuth,
    intent: ArtifactCreateIntent
  ): void {
    // Why: the record can legitimately be gone — an unshare/delete forgets it, and recovery
    // replays a removal whose record a concurrent publish already cleared. Marking is only the
    // crash fence for the record that still exists; without one, dropping the intent is the
    // whole job, and insisting on the mark bricks the source key for every later share.
    if (this.records.getCurrent(auth.profileId, sourceKey, auth.scope)) {
      this.records.markRemoval(auth.profileId, sourceKey, auth.scope, 'applied')
    }
    this.discardIntent(sourceKey, auth, intent.idempotencyKey)
    this.records.remove(auth.profileId, auth.scope, { sourceKey })
  }

  /** Drops a staged removal journal entry without touching the passphrase record. */
  discardIntent(
    sourceKey: string,
    auth: ArtifactPasswordRemovalAuth,
    idempotencyKey?: string
  ): void {
    const key = idempotencyKey ?? this.get(sourceKey, auth)?.idempotencyKey
    if (!key) {
      return
    }
    removeArtifactCreateIntent(
      auth.profileId,
      this.userDataPath,
      removalIntentSourceKey(sourceKey),
      auth.scope,
      key
    )
  }

  async retryWithExecute(
    sourceKey: string,
    auth: ArtifactPasswordRemovalAuth,
    execute: (request: ArtifactWriteRequest) => Promise<ArtifactListItem>
  ): Promise<void> {
    const passwordRecord = this.records.getCurrent(auth.profileId, sourceKey, auth.scope)
    if (passwordRecord?.removalState === 'applied') {
      const appliedIntent = this.get(sourceKey, auth)
      if (appliedIntent) {
        removeArtifactCreateIntent(
          auth.profileId,
          this.userDataPath,
          removalIntentSourceKey(sourceKey),
          auth.scope,
          appliedIntent.idempotencyKey
        )
      }
      this.records.remove(auth.profileId, auth.scope, { sourceKey })
      return
    }
    const intent = this.get(sourceKey, auth)
    if (!intent) {
      if (passwordRecord?.removalState === 'pending') {
        throw new Error('Protected artifact removal journal is incomplete.')
      }
      return
    }
    await execute(requestFromIntent(sourceKey, intent))
    this.complete(sourceKey, auth, intent)
  }

  async retryAll(
    token: string,
    apiUrl: string,
    auth: ArtifactPasswordRemovalAuth,
    publisher: ArtifactPublisher
  ): Promise<void> {
    for (const record of this.records.listCurrent(auth.profileId, auth.scope)) {
      try {
        await this.retry(record.sourceKey, token, apiUrl, auth, publisher)
      } catch {
        // a failed retry leaves the journal and secret intact for the next authenticated call.
      }
    }
  }

  async retry(
    sourceKey: string,
    token: string,
    apiUrl: string,
    auth: ArtifactPasswordRemovalAuth,
    publisher: ArtifactPublisher
  ): Promise<void> {
    const passwordRecord = this.records.getCurrent(auth.profileId, sourceKey, auth.scope)
    if (passwordRecord?.removalState === 'applied') {
      const appliedIntent = this.get(sourceKey, auth)
      if (appliedIntent) {
        removeArtifactCreateIntent(
          auth.profileId,
          this.userDataPath,
          removalIntentSourceKey(sourceKey),
          auth.scope,
          appliedIntent.idempotencyKey
        )
      }
      this.records.remove(auth.profileId, auth.scope, { sourceKey })
      return
    }
    const intent = this.get(sourceKey, auth)
    if (!intent) {
      if (passwordRecord?.removalState === 'pending') {
        throw new Error('Protected artifact removal journal is incomplete.')
      }
      return
    }
    const record = getArtifactShareRecord(auth.profileId, this.userDataPath, sourceKey, auth.scope)
    if (!record) {
      this.complete(sourceKey, auth, intent)
      return
    }
    await publisher.runForSource(sourceKey, auth, () =>
      publisher.runForSlug(record.slug, auth, async () => {
        try {
          const item = await artifactRequest<ArtifactListItem>(apiUrl, token, `/${record.slug}`, {
            method: 'PUT',
            editToken: record.editToken,
            body: intent.body
          })
          auth.assertCurrent()
          refreshArtifactShareRecordExpiration(
            auth.profileId,
            this.userDataPath,
            sourceKey,
            auth.scope,
            record,
            item.artifact.expiresAt
          )
        } catch (error) {
          if (
            !(error instanceof OrcaCloudRequestError) ||
            error.statusCode !== 404 ||
            error.errorCode !== 'artifact_not_found'
          ) {
            throw error
          }
          removeArtifactShareRecords(auth.profileId, this.userDataPath, auth.scope, {
            sourceKey,
            slug: record.slug
          })
        }
        this.complete(sourceKey, auth, intent)
      })
    )
  }

  private get(sourceKey: string, auth: ArtifactPasswordRemovalAuth): ArtifactCreateIntent | null {
    return getArtifactCreateIntent(
      auth.profileId,
      this.userDataPath,
      removalIntentSourceKey(sourceKey),
      auth.scope
    )
  }
}
