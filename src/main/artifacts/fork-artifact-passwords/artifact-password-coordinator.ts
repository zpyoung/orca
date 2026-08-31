import type {
  ArtifactListItem,
  ArtifactListPage,
  ArtifactPublishedLink,
  ArtifactPublishResult,
  ArtifactWriteRequest
} from '../../../shared/artifacts'
import {
  ARTIFACT_PASSWORD_NEUTRAL_NAME,
  type ArtifactProtectionPublication
} from '../../../shared/fork-artifact-passwords/artifact-password-types'
import type { ArtifactPublisher } from '../artifact-publisher'
import { getArtifactShareRecord, type ArtifactShareScope } from '../artifact-share-record-store'
import { generateArtifactPassphrase, protectArtifactWriteRequest } from './artifact-password-crypto'
import {
  ArtifactPasswordCreateCoordinator,
  deleteProtectedArtifact
} from './artifact-password-create-coordinator'
import { ArtifactPasswordRecordStore } from './artifact-password-record-store'
import { ArtifactPasswordRemovalCoordinator } from './artifact-password-removal'
import { ArtifactPasswordOperationQueue } from './artifact-password-operation-queue'
import { ArtifactPasswordRotationCleanup } from './artifact-password-rotation-cleanup'

type ArtifactPasswordAuthContext = {
  profileId: string
  scope: ArtifactShareScope
  assertCurrent: () => void
}

type ProtectedMutation = {
  passphrase: string
  publication: ArtifactProtectionPublication
  request: ArtifactWriteRequest
}

/** Coordinates protected publishing with durable local secret state. */
export class ArtifactPasswordCoordinator {
  private readonly records: ArtifactPasswordRecordStore
  private readonly creates: ArtifactPasswordCreateCoordinator
  private readonly removals: ArtifactPasswordRemovalCoordinator
  private readonly rotations: ArtifactPasswordRotationCleanup
  private readonly queue = new ArtifactPasswordOperationQueue()

  constructor(private readonly userDataPath: string) {
    this.records = new ArtifactPasswordRecordStore(userDataPath)
    this.creates = new ArtifactPasswordCreateCoordinator(userDataPath, this.records)
    this.removals = new ArtifactPasswordRemovalCoordinator(userDataPath, this.records)
    this.rotations = new ArtifactPasswordRotationCleanup(this.records)
  }

  async recover(
    token: string,
    apiUrl: string,
    auth: ArtifactPasswordAuthContext,
    publisher: ArtifactPublisher
  ): Promise<void> {
    await this.removals.retryAll(token, apiUrl, auth, publisher)
    await this.rotations.retry(token, apiUrl, auth, publisher)
  }

  list(page: ArtifactListPage, auth: ArtifactPasswordAuthContext): ArtifactListPage {
    const bySlug = new Map(
      this.records.listCurrent(auth.profileId, auth.scope).map((record) => [record.slug, record])
    )
    const pendingBySlug = new Map<
      string,
      ReturnType<ArtifactPasswordRecordStore['listPending']>[number]
    >()
    for (const pending of this.records.listPending(auth.profileId, auth.scope)) {
      const share = getArtifactShareRecord(
        auth.profileId,
        this.userDataPath,
        pending.sourceKey,
        auth.scope
      )
      if (share) {
        pendingBySlug.set(share.slug, pending)
      }
    }
    return {
      ...page,
      artifacts: page.artifacts.map((item) => {
        const record = bySlug.get(item.artifact.slug)
        const pending = pendingBySlug.get(item.artifact.slug)
        if (record?.removalState === 'applied') {
          return item
        }
        if (record || pending) {
          return {
            ...item,
            local: {
              displayName: pending?.displayName ?? record!.displayName,
              sourceContentType: pending?.sourceContentType ?? record!.sourceContentType,
              sourceKey: pending?.sourceKey ?? record!.sourceKey,
              protection:
                pending ||
                record!.removalState === 'pending' ||
                this.removals.hasPending(record!.sourceKey, auth)
                  ? ('unknown' as const)
                  : record!.passphrase
                    ? ('protected-available' as const)
                    : ('protected-unavailable' as const)
            }
          }
        }
        return item.artifact.title === ARTIFACT_PASSWORD_NEUTRAL_NAME
          ? { ...item, protection: { state: 'unknown' as const } }
          : item
      })
    }
  }

  publishedLink(
    shareUrl: string,
    sourceKey: string,
    revealPassphrase: boolean,
    auth: ArtifactPasswordAuthContext
  ): ArtifactPublishedLink {
    if (this.removals.hasPending(sourceKey, auth)) {
      return { shareUrl, protection: { state: 'unknown' } }
    }
    const current = this.records.getCurrent(auth.profileId, sourceKey, auth.scope)
    if (!current || current.removalState === 'applied') {
      return { shareUrl, protection: { state: 'unprotected' } }
    }
    if (current.removalState === 'pending') {
      return { shareUrl, protection: { state: 'unknown' } }
    }
    return {
      shareUrl,
      protection: current.passphrase
        ? {
            state: 'protected-available',
            ...(revealPassphrase ? { passphrase: current.passphrase } : {}),
            ...(current.rotationCleanup ? { rotationCleanupPending: true } : {})
          }
        : {
            state: 'protected-unavailable',
            ...(current.rotationCleanup ? { rotationCleanupPending: true } : {})
          }
    }
  }

  share(
    request: ArtifactWriteRequest,
    token: string,
    apiUrl: string,
    auth: ArtifactPasswordAuthContext,
    idempotencyKey: string,
    publisher: ArtifactPublisher
  ): Promise<ArtifactListItem> {
    return this.runForSource(request.sourceKey, auth, () =>
      this.shareLocked(request, token, apiUrl, auth, idempotencyKey, publisher)
    )
  }

  private async shareLocked(
    request: ArtifactWriteRequest,
    token: string,
    apiUrl: string,
    auth: ArtifactPasswordAuthContext,
    idempotencyKey: string,
    publisher: ArtifactPublisher
  ): Promise<ArtifactListItem> {
    await this.removals.retry(request.sourceKey, token, apiUrl, auth, publisher)
    const current = this.records.getCurrent(auth.profileId, request.sourceKey, auth.scope)
    const pending = this.records.getPending(auth.profileId, request.sourceKey, auth.scope)
    if (current) {
      if (request.protection?.mode === 'protect' && current.passphrase) {
        const protectedArtifact = await protectArtifactWriteRequest(request, current.passphrase)
        auth.assertCurrent()
        const recovered = await publisher.runForSource(request.sourceKey, auth, () =>
          this.creates.recoverCommitted(protectedArtifact.request, token, apiUrl, auth)
        )
        if (recovered) {
          return {
            ...recovered,
            protection: {
              state: 'protected-available',
              passphrase: current.passphrase
            }
          }
        }
      }
      throw new Error(
        'This artifact is already protected. Update or rotate its existing share instead.'
      )
    }
    if (pending && request.protection?.mode !== 'protect') {
      throw new Error('A protected share is pending and must be retried with protection enabled.')
    }
    if (request.protection?.mode !== 'protect') {
      const item = await publisher.share(request, token, apiUrl, auth, idempotencyKey)
      this.records.remove(auth.profileId, auth.scope, { sourceKey: request.sourceKey })
      return item
    }
    const mutation = await this.prepareExplicitProtection(request, auth, 'protect')
    const item = await publisher.runForSource(request.sourceKey, auth, () =>
      this.creates.create(mutation.request, token, apiUrl, auth, idempotencyKey)
    )
    return { ...item, protection: mutation.publication }
  }

  publish(
    request: ArtifactWriteRequest,
    token: string,
    apiUrl: string,
    auth: ArtifactPasswordAuthContext,
    idempotencyKey: string,
    publisher: ArtifactPublisher
  ): Promise<ArtifactPublishResult> {
    return this.runForSource(request.sourceKey, auth, () =>
      this.publishLocked(request, token, apiUrl, auth, idempotencyKey, publisher)
    )
  }

  private async publishLocked(
    request: ArtifactWriteRequest,
    token: string,
    apiUrl: string,
    auth: ArtifactPasswordAuthContext,
    idempotencyKey: string,
    publisher: ArtifactPublisher
  ): Promise<ArtifactPublishResult> {
    await this.removals.retry(request.sourceKey, token, apiUrl, auth, publisher)
    const cleanupComplete = await this.rotations.retry(
      token,
      apiUrl,
      auth,
      publisher,
      request.sourceKey
    )
    if (
      !cleanupComplete &&
      (request.protection?.mode === 'rotate' || request.protection?.mode === 'remove')
    ) {
      throw new Error(
        'The previous protected link could not be deleted. Retry before changing protection.'
      )
    }
    const pending = this.records.getPending(auth.profileId, request.sourceKey, auth.scope)
    if (request.protection?.mode === 'remove') {
      auth.assertCurrent()
      const removal = this.removals.stage(request, auth)
      const result = await publisher.publish(removal.request, token, apiUrl, auth, idempotencyKey)
      this.removals.complete(request.sourceKey, auth, removal.intent)
      return { ...result, protection: { state: 'unprotected' } }
    }
    if (request.protection?.mode === 'rotate' || pending?.mode === 'rotate') {
      const currentShare = getArtifactShareRecord(
        auth.profileId,
        this.userDataPath,
        request.sourceKey,
        auth.scope
      )
      const previous = pending?.previous ?? currentShare
      if (!previous) {
        throw new Error('This file has not been shared from the active Orca profile.')
      }
      const mutation = await this.prepareExplicitProtection(request, auth, 'rotate', {
        slug: previous.slug,
        editToken: previous.editToken
      })
      const item = await publisher.runForSource(request.sourceKey, auth, () =>
        this.creates.create(mutation.request, token, apiUrl, auth, idempotencyKey)
      )
      let rotationCleanupPending = false
      try {
        await publisher.runForSlug(previous.slug, auth, () =>
          deleteProtectedArtifact(apiUrl, token, previous.slug, previous.editToken)
        )
        this.records.clearRotationCleanup(auth.profileId, request.sourceKey, auth.scope)
      } catch {
        rotationCleanupPending = true
      }
      return {
        change: 'created',
        item,
        protection: { ...mutation.publication, rotationCleanupPending }
      }
    }
    const mutation = await this.preparePublishMutation(request, auth)
    if (!mutation) {
      return publisher.publish(request, token, apiUrl, auth, idempotencyKey)
    }
    const result = await publisher.publish(mutation.request, token, apiUrl, auth, idempotencyKey)
    this.completeMutation(request.sourceKey, result.item, auth)
    return { ...result, protection: mutation.publication }
  }

  update(
    request: ArtifactWriteRequest,
    auth: ArtifactPasswordAuthContext,
    execute: (request: ArtifactWriteRequest) => Promise<ArtifactListItem>
  ): Promise<ArtifactListItem> {
    return this.runForSource(request.sourceKey, auth, () =>
      this.updateLocked(request, auth, execute)
    )
  }

  private async updateLocked(
    request: ArtifactWriteRequest,
    auth: ArtifactPasswordAuthContext,
    execute: (request: ArtifactWriteRequest) => Promise<ArtifactListItem>
  ): Promise<ArtifactListItem> {
    await this.removals.retryWithExecute(request.sourceKey, auth, execute)
    if (request.protection?.mode === 'remove') {
      auth.assertCurrent()
      const removal = this.removals.stage(request, auth)
      const item = await execute(removal.request)
      this.removals.complete(request.sourceKey, auth, removal.intent)
      return { ...item, protection: { state: 'unprotected' } }
    }
    const mutation = await this.preparePublishMutation(request, auth)
    if (!mutation) {
      return execute(request)
    }
    const item = await execute(mutation.request)
    this.completeMutation(request.sourceKey, item, auth)
    return { ...item, protection: mutation.publication }
  }

  forget(auth: ArtifactPasswordAuthContext, match: { sourceKey?: string; slug?: string }): void {
    this.records.remove(auth.profileId, auth.scope, match)
  }

  private async preparePublishMutation(
    request: ArtifactWriteRequest,
    auth: ArtifactPasswordAuthContext
  ): Promise<ProtectedMutation | null> {
    if (request.protection?.mode === 'protect') {
      return this.prepareExplicitProtection(request, auth, 'protect')
    }
    const pending = this.records.getPending(auth.profileId, request.sourceKey, auth.scope)
    if (pending) {
      if (pending.mode === 'rotate') {
        throw new Error('The pending passphrase rotation must be retried from the share panel.')
      }
      if (!pending.passphrase) {
        throw new Error('The pending artifact passphrase is unavailable on this device.')
      }
      const protectedArtifact = await protectArtifactWriteRequest(request, pending.passphrase)
      return {
        passphrase: pending.passphrase,
        publication: { state: 'protected-available' },
        request: protectedArtifact.request
      }
    }
    const current = this.records.getCurrent(auth.profileId, request.sourceKey, auth.scope)
    if (!current) {
      return null
    }
    if (!current.passphrase) {
      throw new Error(
        'The passphrase is unavailable on this device. Rotate protection or delete the artifact.'
      )
    }
    const protectedArtifact = await protectArtifactWriteRequest(request, current.passphrase)
    return {
      passphrase: current.passphrase,
      publication: { state: 'protected-available' },
      request: protectedArtifact.request
    }
  }

  private async prepareExplicitProtection(
    request: ArtifactWriteRequest,
    auth: ArtifactPasswordAuthContext,
    mode: 'protect' | 'rotate',
    previous?: { slug: string; editToken: string }
  ): Promise<ProtectedMutation> {
    const existing = this.records.getPending(auth.profileId, request.sourceKey, auth.scope)
    if (existing && existing.mode !== mode) {
      throw new Error('A different protected artifact operation must finish first.')
    }
    const passphrase = existing?.passphrase ?? generateArtifactPassphrase()
    if (!passphrase) {
      throw new Error('The pending artifact passphrase is unavailable on this device.')
    }
    const protectedArtifact = await protectArtifactWriteRequest(request, passphrase)
    auth.assertCurrent()
    if (!existing) {
      this.records.stage(auth.profileId, request.sourceKey, auth.scope, {
        mode,
        passphrase,
        displayName: protectedArtifact.displayName,
        sourceContentType: protectedArtifact.sourceContentType,
        ...(previous ? { previous } : {})
      })
    }
    return {
      passphrase,
      publication: { state: 'protected-available', passphrase },
      request: protectedArtifact.request
    }
  }

  private completeMutation(
    sourceKey: string,
    item: ArtifactListItem,
    auth: ArtifactPasswordAuthContext
  ): void {
    const record = getArtifactShareRecord(auth.profileId, this.userDataPath, sourceKey, auth.scope)
    if (!record) {
      throw new Error('The protected artifact share record was not saved.')
    }
    const pending = this.records.getPending(auth.profileId, sourceKey, auth.scope)
    if (pending) {
      this.records.finalizePending(auth.profileId, sourceKey, auth.scope, {
        slug: item.artifact.slug,
        editToken: record.editToken,
        shareUrl: item.shareUrl,
        expiresAt: item.artifact.expiresAt
      })
    } else {
      this.records.rebindCurrent(
        auth.profileId,
        sourceKey,
        auth.scope,
        item.artifact.slug,
        item.artifact.expiresAt
      )
    }
  }

  runForLifecycleSource<T>(
    sourceKey: string,
    auth: ArtifactPasswordAuthContext,
    operation: () => Promise<T>
  ): Promise<T> {
    return this.runForSource(sourceKey, auth, operation)
  }

  runForLifecycleSlug<T>(
    slug: string,
    auth: ArtifactPasswordAuthContext,
    operation: () => Promise<T>
  ): Promise<T> {
    const sourceKey =
      this.records.listCurrent(auth.profileId, auth.scope).find((record) => record.slug === slug)
        ?.sourceKey ??
      this.records
        .listPending(auth.profileId, auth.scope)
        .find((record) => record.created?.slug === slug)?.sourceKey
    return sourceKey ? this.runForSource(sourceKey, auth, operation) : operation()
  }

  ensureRotationCleanupBeforeForget(
    match: { sourceKey?: string; slug?: string },
    token: string,
    apiUrl: string,
    auth: ArtifactPasswordAuthContext,
    publisher: ArtifactPublisher
  ): Promise<void> {
    return this.rotations.ensureBeforeForget(match, token, apiUrl, auth, publisher)
  }

  private runForSource<T>(
    sourceKey: string,
    auth: ArtifactPasswordAuthContext,
    operation: () => Promise<T>
  ): Promise<T> {
    const key = JSON.stringify([
      auth.profileId,
      auth.scope.cloudUserId,
      auth.scope.cloudProfileId,
      auth.scope.cloudOrganizationId,
      auth.scope.apiOrigin,
      sourceKey
    ])
    return this.queue.run(key, operation)
  }
}
