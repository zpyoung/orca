import { createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import type { ArtifactWriteRequest } from '../../../shared/artifacts'
import {
  ARTIFACT_CLI_MAX_RPC_BYTES,
  artifactWriteRequestByteLength
} from '../../../shared/artifacts'
import {
  ARTIFACT_PASSWORD_NEUTRAL_NAME,
  ARTIFACT_PASSWORD_PBKDF2_ITERATIONS
} from '../../../shared/fork-artifact-passwords/artifact-password-types'
import {
  ArtifactProtectedPageTooLargeError,
  generateArtifactPassphrase,
  protectArtifactWriteRequest
} from './artifact-password-crypto'
import { EFF_LARGE_WORDLIST, EFF_LARGE_WORDLIST_SHA256 } from './eff-diceware-wordlist'

function request(content: string, contentType: 'text/html' | 'text/markdown' = 'text/html') {
  return {
    sourceKey: '/secret/report.html',
    content,
    contentType,
    fileName: 'Q3-layoffs-plan.html',
    title: 'Confidential plan'
  } satisfies ArtifactWriteRequest
}

function decrypt(
  result: Awaited<ReturnType<typeof protectArtifactWriteRequest>>,
  passphrase: string
): string {
  const { envelope } = result
  const key = pbkdf2Sync(
    passphrase,
    Buffer.from(envelope.salt, 'base64'),
    ARTIFACT_PASSWORD_PBKDF2_ITERATIONS,
    32,
    'sha256'
  )
  const payload = Buffer.from(envelope.ciphertext, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'))
  decipher.setAAD(Buffer.from(envelope.aad))
  decipher.setAuthTag(payload.subarray(-16))
  return gunzipSync(
    Buffer.concat([decipher.update(payload.subarray(0, -16)), decipher.final()])
  ).toString('utf8')
}

describe('artifact password crypto', () => {
  it('uses the pinned 7,776-entry EFF large wordlist', async () => {
    expect(EFF_LARGE_WORDLIST).toHaveLength(7_776)
    expect(new Set(EFF_LARGE_WORDLIST).size).toBe(7_776)
    expect(
      createHash('sha256')
        .update(`${EFF_LARGE_WORDLIST.join('\n')}\n`)
        .digest('hex')
    ).toBe(EFF_LARGE_WORDLIST_SHA256)
    const words = generateArtifactPassphrase().split(' ')
    expect(words).toHaveLength(6)
    expect(words.every((word) => EFF_LARGE_WORDLIST.includes(word))).toBe(true)
  })

  it('round trips HTML without exposing plaintext metadata in the upload', async () => {
    const passphrase = 'abacus abdomen abdominal abide abiding ability'
    const result = await protectArtifactWriteRequest(request('<h1>Top secret</h1>'), passphrase)

    expect(decrypt(result, passphrase)).toBe('<h1>Top secret</h1>')
    expect(result.request.contentType).toBe('text/html')
    expect(result.request.fileName).toBe(`${ARTIFACT_PASSWORD_NEUTRAL_NAME}.html`)
    expect(result.request.title).toBe(ARTIFACT_PASSWORD_NEUTRAL_NAME)
    expect(result.request.content).not.toContain('Top secret')
    expect(result.request.content).not.toContain('Q3-layoffs-plan')
    expect(result.request.content).not.toContain(passphrase)
    expect(result.request.content).toContain('name="robots" content="noindex,nofollow"')
    expect(result.request.content).toContain('type="password"')
    expect(result.request.content).toContain('type="button"')
    expect(result.request.content).toContain('Wrong passphrase.')
    expect(result.request.content).not.toContain('<form')
  })

  it('renders Markdown in main before encrypting and preserves raw inline scripts', async () => {
    const passphrase = generateArtifactPassphrase()
    const result = await protectArtifactWriteRequest(
      request('# Report\n\n<script>window.reportReady = true</script>', 'text/markdown'),
      passphrase
    )
    const html = decrypt(result, passphrase)

    expect(html).toContain('<h1>Report</h1>')
    expect(html).toContain('<script>window.reportReady = true</script>')
  })

  it('uses fresh salt and IV for every publish', async () => {
    const passphrase = generateArtifactPassphrase()
    const first = await protectArtifactWriteRequest(request('<p>same</p>'), passphrase)
    const second = await protectArtifactWriteRequest(request('<p>same</p>'), passphrase)

    expect(first.envelope.salt).not.toBe(second.envelope.salt)
    expect(first.envelope.iv).not.toBe(second.envelope.iv)
    expect(first.envelope.ciphertext).not.toBe(second.envelope.ciphertext)
  })

  it('authenticates the envelope parameters and ciphertext', async () => {
    const passphrase = generateArtifactPassphrase()
    const result = await protectArtifactWriteRequest(request('<p>bound</p>'), passphrase)
    result.envelope.aad = result.envelope.aad.replace('600000', '600001')

    expect(() => decrypt(result, passphrase)).toThrow()
  })

  it('checks the exact final serialized request budget', async () => {
    const compressible = await protectArtifactWriteRequest(
      request(`<p>${'a'.repeat(ARTIFACT_CLI_MAX_RPC_BYTES - 20_000)}</p>`),
      generateArtifactPassphrase()
    )
    expect(artifactWriteRequestByteLength(compressible.request)).toBeLessThanOrEqual(
      ARTIFACT_CLI_MAX_RPC_BYTES
    )

    await expect(
      protectArtifactWriteRequest(
        request(
          Array.from({ length: 22_000 }, (_, index) =>
            createHash('sha256').update(String(index)).digest('base64')
          ).join('')
        ),
        generateArtifactPassphrase()
      )
    ).rejects.toThrow(ArtifactProtectedPageTooLargeError)
  })
})
