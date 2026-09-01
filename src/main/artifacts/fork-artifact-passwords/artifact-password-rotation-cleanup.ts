import type { ArtifactPublisher } from '../artifact-publisher'
import type { ArtifactShareScope } from '../artifact-share-record-store'
import { deleteProtectedArtifact } from './artifact-password-create-coordinator'
import type { ArtifactPasswordRecordStore } from './artifact-password-record-store'

type RotationCleanupAuth = {
  profileId: string
  scope: ArtifactShareScope
  assertCurrent: () => void
}

/** Retains old-link credentials until deletion is confirmed or returns artifact-not-found. */
export class ArtifactPasswordRotationCleanup {
  constructor(private readonly records: ArtifactPasswordRecordStore) {}

  async ensureBeforeForget(
    match: { sourceKey?: string; slug?: string },
    token: string,
    apiUrl: string,
    auth: RotationCleanupAuth,
    publisher: ArtifactPublisher
  ): Promise<void> {
    const records = this.records
      .listCurrent(auth.profileId, auth.scope)
      .filter(
        (record) =>
          (match.sourceKey !== undefined && record.sourceKey === match.sourceKey) ||
          (match.slug !== undefined && record.slug === match.slug)
      )
    for (const record of records) {
      const cleanup = record.rotationCleanup
      if (!cleanup) {
        continue
      }
      try {
        await publisher.runForSlug(cleanup.slug, auth, () =>
          deleteProtectedArtifact(apiUrl, token, cleanup.slug, cleanup.editToken)
        )
      } catch {
        throw new Error(
          'The previous protected link could not be deleted, so its recovery record was kept.'
        )
      }
      auth.assertCurrent()
      this.records.clearRotationCleanup(auth.profileId, record.sourceKey, auth.scope)
    }
  }

  async retry(
    token: string,
    apiUrl: string,
    auth: RotationCleanupAuth,
    publisher: ArtifactPublisher,
    targetSourceKey?: string
  ): Promise<boolean> {
    let complete = true
    for (const record of this.records.listCurrent(auth.profileId, auth.scope)) {
      const cleanup = record.rotationCleanup
      if (!cleanup) {
        continue
      }
      try {
        await publisher.runForSlug(cleanup.slug, auth, () =>
          deleteProtectedArtifact(apiUrl, token, cleanup.slug, cleanup.editToken)
        )
        auth.assertCurrent()
        this.records.clearRotationCleanup(auth.profileId, record.sourceKey, auth.scope)
      } catch {
        if (record.sourceKey === targetSourceKey) {
          complete = false
        }
      }
    }
    return complete
  }
}
