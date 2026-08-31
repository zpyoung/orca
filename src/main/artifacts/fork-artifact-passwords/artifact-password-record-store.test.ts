import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactShareScope } from '../artifact-share-record-store'

const safeStorageMock = vi.hoisted(() => ({
  decryptString: vi.fn((value: Buffer) =>
    Buffer.from(value.toString('utf8'), 'base64').toString('utf8')
  ),
  encryptString: vi.fn((value: string) => Buffer.from(Buffer.from(value).toString('base64'))),
  getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret'),
  isEncryptionAvailable: vi.fn(() => true)
}))

vi.mock('electron', () => ({ safeStorage: safeStorageMock }))

import { ArtifactPasswordRecordStore } from './artifact-password-record-store'

const paths: string[] = []
const scope: ArtifactShareScope = {
  cloudUserId: 'user-a',
  cloudProfileId: 'cloud-a',
  cloudOrganizationId: 'org-a',
  apiOrigin: 'https://share.onorca.dev'
}

async function createStore(): Promise<{ path: string; store: ArtifactPasswordRecordStore }> {
  const path = await mkdtemp(join(tmpdir(), 'orca-artifact-passwords-'))
  paths.push(path)
  await mkdir(join(path, 'profiles', 'profile-a'), { recursive: true })
  return { path, store: new ArtifactPasswordRecordStore(path) }
}

beforeEach(() => {
  safeStorageMock.decryptString.mockReset()
  safeStorageMock.decryptString.mockImplementation((value: Buffer) =>
    Buffer.from(value.toString('utf8'), 'base64').toString('utf8')
  )
  safeStorageMock.encryptString.mockReset()
  safeStorageMock.encryptString.mockImplementation((value: string) =>
    Buffer.from(Buffer.from(value).toString('base64'))
  )
  safeStorageMock.getSelectedStorageBackend.mockReturnValue('gnome_libsecret')
  safeStorageMock.isEncryptionAvailable.mockReturnValue(true)
})

afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('artifact password record store', () => {
  it('durably stages and finalizes a secret without storing plaintext', async () => {
    const { path, store } = await createStore()
    store.stage('profile-a', '/repo/report.html', scope, {
      mode: 'protect',
      passphrase: 'six private words never plaintext',
      displayName: 'report.html',
      sourceContentType: 'text/html'
    })
    store.markCreated('profile-a', '/repo/report.html', scope, {
      slug: 'artifact-a',
      editToken: 'edit-a',
      shareUrl: 'https://share.onorca.dev/a/artifact-a',
      expiresAt: '2099-01-01T00:00:00.000Z'
    })
    store.finalizePending('profile-a', '/repo/report.html', scope, {
      slug: 'artifact-a',
      editToken: 'edit-a',
      shareUrl: 'https://share.onorca.dev/a/artifact-a',
      expiresAt: '2099-01-01T00:00:00.000Z'
    })

    expect(store.getCurrent('profile-a', '/repo/report.html', scope)).toMatchObject({
      slug: 'artifact-a',
      displayName: 'report.html',
      passphrase: 'six private words never plaintext'
    })
    const persisted = await readFile(
      join(path, 'profiles', 'profile-a', 'artifact-passwords.json'),
      'utf8'
    )
    expect(persisted).not.toContain('six private words never plaintext')
  })

  it('fails before staging when secure system storage is unavailable', async () => {
    const { store } = await createStore()
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)

    expect(() =>
      store.stage('profile-a', '/repo/report.html', scope, {
        mode: 'protect',
        passphrase: 'not stored',
        displayName: 'report.html',
        sourceContentType: 'text/html'
      })
    ).toThrow(/Secure system storage is unavailable/)
    expect(store.getPending('profile-a', '/repo/report.html', scope)).toBeNull()
  })

  it('retains unreadable ciphertext and reports the passphrase unavailable', async () => {
    const { path, store } = await createStore()
    store.stage('profile-a', '/repo/report.html', scope, {
      mode: 'protect',
      passphrase: 'recoverable before failure',
      displayName: 'report.html',
      sourceContentType: 'text/html'
    })
    store.finalizePending('profile-a', '/repo/report.html', scope, {
      slug: 'artifact-a',
      editToken: 'edit-a',
      shareUrl: 'https://share.onorca.dev/a/artifact-a',
      expiresAt: '2099-01-01T00:00:00.000Z'
    })
    const persistedPath = join(path, 'profiles', 'profile-a', 'artifact-passwords.json')
    const before = await readFile(persistedPath, 'utf8')
    safeStorageMock.decryptString.mockImplementation(() => {
      throw new Error('key changed')
    })

    expect(store.getCurrent('profile-a', '/repo/report.html', scope)?.passphrase).toBeNull()
    expect(await readFile(persistedPath, 'utf8')).toBe(before)
  })

  it('keeps old credentials until rotation cleanup is confirmed', async () => {
    const { store } = await createStore()
    store.stage('profile-a', '/repo/report.html', scope, {
      mode: 'rotate',
      passphrase: 'new protected phrase',
      displayName: 'report.html',
      sourceContentType: 'text/html',
      previous: { slug: 'artifact-old', editToken: 'edit-old' }
    })
    store.finalizePending('profile-a', '/repo/report.html', scope, {
      slug: 'artifact-new',
      editToken: 'edit-new',
      shareUrl: 'https://share.onorca.dev/a/artifact-new',
      expiresAt: '2099-01-01T00:00:00.000Z'
    })

    expect(store.getCurrent('profile-a', '/repo/report.html', scope)?.rotationCleanup).toEqual({
      slug: 'artifact-old',
      editToken: 'edit-old'
    })
    store.clearRotationCleanup('profile-a', '/repo/report.html', scope)
    expect(
      store.getCurrent('profile-a', '/repo/report.html', scope)?.rotationCleanup
    ).toBeUndefined()
  })

  it('removes only the matched source when other operations are pending', async () => {
    const { store } = await createStore()
    for (const sourceKey of ['/repo/first.html', '/repo/second.html']) {
      store.stage('profile-a', sourceKey, scope, {
        mode: 'protect',
        passphrase: `password for ${sourceKey}`,
        displayName: sourceKey.split('/').at(-1)!,
        sourceContentType: 'text/html'
      })
    }

    store.remove('profile-a', scope, { sourceKey: '/repo/first.html' })

    expect(store.getPending('profile-a', '/repo/first.html', scope)).toBeNull()
    expect(store.getPending('profile-a', '/repo/second.html', scope)?.passphrase).toBe(
      'password for /repo/second.html'
    )
  })
})
