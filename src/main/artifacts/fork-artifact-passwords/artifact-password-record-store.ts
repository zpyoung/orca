import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { safeStorage } from 'electron'
import { writeDurableSecureJsonFile } from '../../../shared/secure-file'
import { getOrcaProfileDirectory } from '../../orca-profiles/profile-storage-paths'
import type { ArtifactShareScope } from '../artifact-share-record-store'

export type ArtifactPasswordCredentials = {
  slug: string
  editToken: string
  shareUrl: string
  expiresAt: string
}

type ArtifactPasswordMetadata = {
  displayName: string
  sourceContentType: 'text/html' | 'text/markdown'
}

type StoredArtifactPasswordCurrent = ArtifactPasswordMetadata & {
  slug: string
  passphraseBlob: string
  expiresAt: string
  rotationCleanup?: { slug: string; editToken: string }
  removalState?: 'pending' | 'applied'
  completedCreateIntentId?: string
}

type StoredArtifactPasswordPending = ArtifactPasswordMetadata & {
  mode: 'protect' | 'rotate'
  passphraseBlob: string
  previous?: { slug: string; editToken: string }
  created?: ArtifactPasswordCredentials
}

type StoredArtifactPasswordEntry = {
  sourceKey: string
  scope: ArtifactShareScope
  current?: StoredArtifactPasswordCurrent
  pending?: StoredArtifactPasswordPending
}

type ArtifactPasswordFile = {
  version: 1
  entries: Record<string, StoredArtifactPasswordEntry>
}

export type ArtifactPasswordRecord = ArtifactPasswordMetadata & {
  sourceKey: string
  slug: string
  expiresAt: string
  passphrase: string | null
  rotationCleanup?: { slug: string; editToken: string }
  removalState?: 'pending' | 'applied'
  completedCreateIntentId?: string
}

export type ArtifactPasswordPending = ArtifactPasswordMetadata & {
  mode: 'protect' | 'rotate'
  passphrase: string | null
  previous?: { slug: string; editToken: string }
  created?: ArtifactPasswordCredentials
}

function storagePath(profileId: string, userDataPath: string): string {
  return join(getOrcaProfileDirectory(profileId, userDataPath), 'artifact-passwords.json')
}

function entryKey(sourceKey: string, scope: ArtifactShareScope): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        sourceKey,
        scope.cloudUserId,
        scope.cloudProfileId,
        scope.cloudOrganizationId,
        scope.apiOrigin
      ])
    )
    .digest('hex')
}

function validScope(value: unknown): value is ArtifactShareScope {
  if (!value || typeof value !== 'object') {
    return false
  }
  const scope = value as Partial<ArtifactShareScope>
  return [
    scope.cloudUserId,
    scope.cloudProfileId,
    scope.cloudOrganizationId,
    scope.apiOrigin
  ].every((field) => typeof field === 'string')
}

function validMetadata(value: unknown): value is ArtifactPasswordMetadata {
  if (!value || typeof value !== 'object') {
    return false
  }
  const metadata = value as Partial<ArtifactPasswordMetadata>
  return (
    typeof metadata.displayName === 'string' &&
    metadata.displayName.length > 0 &&
    ['text/html', 'text/markdown'].includes(metadata.sourceContentType ?? '')
  )
}

function validCredentials(value: unknown): value is ArtifactPasswordCredentials {
  if (!value || typeof value !== 'object') {
    return false
  }
  const credentials = value as Partial<ArtifactPasswordCredentials>
  return [
    credentials.slug,
    credentials.editToken,
    credentials.shareUrl,
    credentials.expiresAt
  ].every((field) => typeof field === 'string' && field.length > 0)
}

function validPending(value: unknown): value is StoredArtifactPasswordPending {
  if (!validMetadata(value)) {
    return false
  }
  const pending = value as Partial<StoredArtifactPasswordPending>
  return (
    ['protect', 'rotate'].includes(pending.mode ?? '') &&
    typeof pending.passphraseBlob === 'string' &&
    pending.passphraseBlob.length > 0 &&
    (pending.previous === undefined ||
      (typeof pending.previous.slug === 'string' &&
        typeof pending.previous.editToken === 'string')) &&
    (pending.created === undefined || validCredentials(pending.created))
  )
}

function validCurrent(value: unknown): value is StoredArtifactPasswordCurrent {
  if (!validMetadata(value)) {
    return false
  }
  const current = value as Partial<StoredArtifactPasswordCurrent>
  return (
    typeof current.slug === 'string' &&
    current.slug.length > 0 &&
    typeof current.passphraseBlob === 'string' &&
    current.passphraseBlob.length > 0 &&
    typeof current.expiresAt === 'string' &&
    (current.rotationCleanup === undefined ||
      (typeof current.rotationCleanup.slug === 'string' &&
        typeof current.rotationCleanup.editToken === 'string')) &&
    (current.removalState === undefined || ['pending', 'applied'].includes(current.removalState)) &&
    (current.completedCreateIntentId === undefined ||
      typeof current.completedCreateIntentId === 'string')
  )
}

function validEntry(value: unknown): value is StoredArtifactPasswordEntry {
  if (!value || typeof value !== 'object') {
    return false
  }
  const entry = value as Partial<StoredArtifactPasswordEntry>
  return (
    typeof entry.sourceKey === 'string' &&
    validScope(entry.scope) &&
    (entry.current === undefined || validCurrent(entry.current)) &&
    (entry.pending === undefined || validPending(entry.pending)) &&
    (entry.current !== undefined || entry.pending !== undefined)
  )
}

function sameScope(left: ArtifactShareScope, right: ArtifactShareScope): boolean {
  return (
    left.cloudUserId === right.cloudUserId &&
    left.cloudProfileId === right.cloudProfileId &&
    left.cloudOrganizationId === right.cloudOrganizationId &&
    left.apiOrigin === right.apiOrigin
  )
}

function readFile(profileId: string, userDataPath: string): ArtifactPasswordFile {
  const path = storagePath(profileId, userDataPath)
  if (!existsSync(path)) {
    return { version: 1, entries: {} }
  }
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error('Protected artifact records could not be read safely.', { cause: error })
  }
  if (!value || typeof value !== 'object') {
    throw new Error('Protected artifact records have an unsupported format.')
  }
  const parsed = value as Partial<ArtifactPasswordFile>
  if (
    parsed.version !== 1 ||
    !parsed.entries ||
    typeof parsed.entries !== 'object' ||
    Array.isArray(parsed.entries) ||
    !Object.values(parsed.entries).every(validEntry)
  ) {
    throw new Error('Protected artifact records have an unsupported format.')
  }
  return parsed as ArtifactPasswordFile
}

function assertSecureStorageAvailable(): void {
  let available = false
  try {
    available = safeStorage.isEncryptionAvailable()
    if (
      process.platform === 'linux' &&
      (!available || ['basic_text', 'unknown'].includes(safeStorage.getSelectedStorageBackend()))
    ) {
      available = false
    }
  } catch {
    available = false
  }
  if (!available) {
    throw new Error('Secure system storage is unavailable. Protected publishing was not started.')
  }
}

function encryptPassphrase(passphrase: string): string {
  assertSecureStorageAvailable()
  try {
    return safeStorage.encryptString(passphrase).toString('base64')
  } catch (error) {
    throw new Error('The artifact passphrase could not be stored securely.', { cause: error })
  }
}

function decryptPassphrase(blob: string): string | null {
  try {
    assertSecureStorageAvailable()
    return safeStorage.decryptString(Buffer.from(blob, 'base64'))
  } catch {
    return null
  }
}

/** Persists artifact passphrases fail-closed through Electron safeStorage. */
export class ArtifactPasswordRecordStore {
  constructor(private readonly userDataPath: string) {}

  getCurrent(
    profileId: string,
    sourceKey: string,
    scope: ArtifactShareScope
  ): ArtifactPasswordRecord | null {
    const entry = this.getEntry(profileId, sourceKey, scope)
    if (!entry?.current) {
      return null
    }
    return {
      sourceKey,
      slug: entry.current.slug,
      displayName: entry.current.displayName,
      sourceContentType: entry.current.sourceContentType,
      expiresAt: entry.current.expiresAt,
      passphrase: decryptPassphrase(entry.current.passphraseBlob),
      ...(entry.current.rotationCleanup ? { rotationCleanup: entry.current.rotationCleanup } : {}),
      ...(entry.current.removalState ? { removalState: entry.current.removalState } : {}),
      ...(entry.current.completedCreateIntentId
        ? { completedCreateIntentId: entry.current.completedCreateIntentId }
        : {})
    }
  }

  getPending(
    profileId: string,
    sourceKey: string,
    scope: ArtifactShareScope
  ): ArtifactPasswordPending | null {
    const pending = this.getEntry(profileId, sourceKey, scope)?.pending
    if (!pending) {
      return null
    }
    return {
      mode: pending.mode,
      displayName: pending.displayName,
      sourceContentType: pending.sourceContentType,
      passphrase: decryptPassphrase(pending.passphraseBlob),
      ...(pending.previous ? { previous: pending.previous } : {}),
      ...(pending.created ? { created: pending.created } : {})
    }
  }

  listCurrent(profileId: string, scope: ArtifactShareScope): readonly ArtifactPasswordRecord[] {
    const file = readFile(profileId, this.userDataPath)
    return Object.values(file.entries)
      .filter((entry) => sameScope(entry.scope, scope) && entry.current)
      .map((entry) => this.getCurrent(profileId, entry.sourceKey, scope))
      .filter((entry): entry is ArtifactPasswordRecord => entry !== null)
  }

  listPending(
    profileId: string,
    scope: ArtifactShareScope
  ): readonly (ArtifactPasswordPending & { sourceKey: string })[] {
    const file = readFile(profileId, this.userDataPath)
    return Object.values(file.entries)
      .filter((entry) => sameScope(entry.scope, scope) && entry.pending)
      .map((entry) => {
        const pending = this.getPending(profileId, entry.sourceKey, scope)
        return pending ? { ...pending, sourceKey: entry.sourceKey } : null
      })
      .filter((entry): entry is ArtifactPasswordPending & { sourceKey: string } => entry !== null)
  }

  stage(
    profileId: string,
    sourceKey: string,
    scope: ArtifactShareScope,
    pending: Omit<ArtifactPasswordPending, 'passphrase'> & { passphrase: string }
  ): void {
    const file = readFile(profileId, this.userDataPath)
    const key = entryKey(sourceKey, scope)
    const existing = file.entries[key]
    file.entries[key] = {
      sourceKey,
      scope,
      ...(existing?.current ? { current: existing.current } : {}),
      pending: {
        mode: pending.mode,
        displayName: pending.displayName,
        sourceContentType: pending.sourceContentType,
        passphraseBlob: encryptPassphrase(pending.passphrase),
        ...(pending.previous ? { previous: pending.previous } : {}),
        ...(pending.created ? { created: pending.created } : {})
      }
    }
    this.write(profileId, file)
  }

  markCreated(
    profileId: string,
    sourceKey: string,
    scope: ArtifactShareScope,
    credentials: ArtifactPasswordCredentials
  ): void {
    const file = readFile(profileId, this.userDataPath)
    const entry = file.entries[entryKey(sourceKey, scope)]
    if (!entry?.pending) {
      throw new Error('Protected artifact create state is missing.')
    }
    entry.pending = { ...entry.pending, created: credentials }
    this.write(profileId, file)
  }

  finalizePending(
    profileId: string,
    sourceKey: string,
    scope: ArtifactShareScope,
    credentials: ArtifactPasswordCredentials,
    completedCreateIntentId?: string
  ): void {
    const file = readFile(profileId, this.userDataPath)
    const entry = file.entries[entryKey(sourceKey, scope)]
    if (!entry?.pending) {
      throw new Error('Protected artifact publish state is missing.')
    }
    entry.current = {
      slug: credentials.slug,
      passphraseBlob: entry.pending.passphraseBlob,
      displayName: entry.pending.displayName,
      sourceContentType: entry.pending.sourceContentType,
      expiresAt: credentials.expiresAt,
      ...(entry.pending.previous ? { rotationCleanup: entry.pending.previous } : {}),
      ...(completedCreateIntentId ? { completedCreateIntentId } : {})
    }
    delete entry.pending
    this.write(profileId, file)
  }

  markRemoval(
    profileId: string,
    sourceKey: string,
    scope: ArtifactShareScope,
    state: 'pending' | 'applied'
  ): void {
    const file = readFile(profileId, this.userDataPath)
    const current = file.entries[entryKey(sourceKey, scope)]?.current
    if (!current) {
      throw new Error('Protected artifact state is missing during removal.')
    }
    current.removalState = state
    this.write(profileId, file)
  }

  rebindCurrent(
    profileId: string,
    sourceKey: string,
    scope: ArtifactShareScope,
    slug: string,
    expiresAt: string
  ): void {
    const file = readFile(profileId, this.userDataPath)
    const current = file.entries[entryKey(sourceKey, scope)]?.current
    if (!current) {
      return
    }
    current.slug = slug
    current.expiresAt = expiresAt
    this.write(profileId, file)
  }

  refresh(
    profileId: string,
    sourceKey: string,
    scope: ArtifactShareScope,
    expiresAt: string
  ): void {
    const file = readFile(profileId, this.userDataPath)
    const current = file.entries[entryKey(sourceKey, scope)]?.current
    if (!current) {
      return
    }
    current.expiresAt = expiresAt
    this.write(profileId, file)
  }

  clearRotationCleanup(profileId: string, sourceKey: string, scope: ArtifactShareScope): void {
    const file = readFile(profileId, this.userDataPath)
    const current = file.entries[entryKey(sourceKey, scope)]?.current
    if (!current?.rotationCleanup) {
      return
    }
    delete current.rotationCleanup
    this.write(profileId, file)
  }

  clearPending(profileId: string, sourceKey: string, scope: ArtifactShareScope): void {
    const file = readFile(profileId, this.userDataPath)
    const key = entryKey(sourceKey, scope)
    const entry = file.entries[key]
    if (!entry?.pending) {
      return
    }
    delete entry.pending
    if (!entry.current) {
      delete file.entries[key]
    }
    this.write(profileId, file)
  }

  remove(
    profileId: string,
    scope: ArtifactShareScope,
    match: { sourceKey?: string; slug?: string }
  ): void {
    const file = readFile(profileId, this.userDataPath)
    for (const [key, entry] of Object.entries(file.entries)) {
      if (
        sameScope(entry.scope, scope) &&
        ((match.sourceKey !== undefined && entry.sourceKey === match.sourceKey) ||
          (match.slug !== undefined && entry.current?.slug === match.slug))
      ) {
        delete file.entries[key]
      }
    }
    this.write(profileId, file)
  }

  clear(profileId: string): void {
    this.write(profileId, { version: 1, entries: {} })
  }

  private getEntry(
    profileId: string,
    sourceKey: string,
    scope: ArtifactShareScope
  ): StoredArtifactPasswordEntry | null {
    const entry = readFile(profileId, this.userDataPath).entries[entryKey(sourceKey, scope)]
    return entry && sameScope(entry.scope, scope) && entry.sourceKey === sourceKey ? entry : null
  }

  private write(profileId: string, file: ArtifactPasswordFile): void {
    writeDurableSecureJsonFile(storagePath(profileId, this.userDataPath), file)
  }
}

export function clearArtifactPasswordRecords(profileId: string, userDataPath: string): void {
  new ArtifactPasswordRecordStore(userDataPath).clear(profileId)
}
