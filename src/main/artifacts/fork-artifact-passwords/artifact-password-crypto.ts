import { createCipheriv, pbkdf2, randomBytes, randomInt } from 'node:crypto'
import { promisify } from 'node:util'
import { gzipSync } from 'node:zlib'
import type { ArtifactWriteRequest } from '../../../shared/artifacts'
import {
  ARTIFACT_PASSWORD_MAX_PLAINTEXT_BYTES,
  ARTIFACT_PASSWORD_NEUTRAL_NAME,
  ARTIFACT_PASSWORD_PBKDF2_ITERATIONS,
  ARTIFACT_PROTECTED_PAGE_MAX_BYTES,
  normalizeArtifactPassphrase
} from '../../../shared/fork-artifact-passwords/artifact-password-types'
import { artifactWriteRequestByteLength } from '../../../shared/artifacts'
import { renderProtectedArtifactMarkdown } from './artifact-password-markdown-document'
import {
  artifactPasswordEnvelopeAad,
  renderArtifactPasswordUnlockPage,
  type ArtifactPasswordEnvelope
} from './artifact-password-unlock-page'
import { EFF_LARGE_WORDLIST } from './eff-diceware-wordlist'

const derivePbkdf2Key = promisify(pbkdf2)

/** Reports the exact serialized request overage after protection. */
export class ArtifactProtectedPageTooLargeError extends Error {
  constructor(
    readonly actualBytes: number,
    readonly maximumBytes: number
  ) {
    super(
      `Protected artifact request is ${actualBytes - maximumBytes} bytes over the ${maximumBytes}-byte limit.`
    )
  }
}

export type ProtectedArtifactRequest = {
  request: ArtifactWriteRequest
  envelope: ArtifactPasswordEnvelope
  displayName: string
  sourceContentType: 'text/html' | 'text/markdown'
}

/** Generates six independent words from EFF's 7,776-entry 2016 large Diceware list. */
export function generateArtifactPassphrase(): string {
  if (EFF_LARGE_WORDLIST.length !== 7_776) {
    throw new Error('The artifact passphrase wordlist is invalid.')
  }
  return Array.from(
    { length: 6 },
    () => EFF_LARGE_WORDLIST[randomInt(EFF_LARGE_WORDLIST.length)]
  ).join(' ')
}

function artifactPlaintext(request: ArtifactWriteRequest): string {
  return request.contentType === 'text/markdown'
    ? renderProtectedArtifactMarkdown(request.content, request.title?.trim() || request.fileName)
    : request.content
}

/** Encrypts an artifact into a self-contained unlock page with fresh salt and IV. */
export async function protectArtifactWriteRequest(
  request: ArtifactWriteRequest,
  rawPassphrase: string
): Promise<ProtectedArtifactRequest> {
  const passphrase = normalizeArtifactPassphrase(rawPassphrase)
  const plaintext = Buffer.from(artifactPlaintext(request), 'utf8')
  if (plaintext.byteLength > ARTIFACT_PASSWORD_MAX_PLAINTEXT_BYTES) {
    throw new Error('Artifact plaintext exceeds the protected artifact limit.')
  }
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const compressed = gzipSync(plaintext, { level: 9 })
  const key = await derivePbkdf2Key(
    Buffer.from(passphrase, 'utf8'),
    salt,
    ARTIFACT_PASSWORD_PBKDF2_ITERATIONS,
    32,
    'sha256'
  )
  const envelopeHeader = {
    version: 1 as const,
    kdf: 'PBKDF2-SHA-256' as const,
    iterations: ARTIFACT_PASSWORD_PBKDF2_ITERATIONS,
    cipher: 'AES-256-GCM' as const,
    compression: 'gzip' as const,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    plaintextBytes: plaintext.byteLength
  }
  const aad = artifactPasswordEnvelopeAad(envelopeHeader)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const encrypted = Buffer.concat([cipher.update(compressed), cipher.final(), cipher.getAuthTag()])
  key.fill(0)
  compressed.fill(0)
  plaintext.fill(0)
  const envelope: ArtifactPasswordEnvelope = {
    ...envelopeHeader,
    aad,
    ciphertext: encrypted.toString('base64')
  }
  encrypted.fill(0)
  const { protection: _protection, ...baseRequest } = request
  const protectedRequest: ArtifactWriteRequest = {
    ...baseRequest,
    content: renderArtifactPasswordUnlockPage(envelope),
    contentType: 'text/html',
    fileName: `${ARTIFACT_PASSWORD_NEUTRAL_NAME}.html`,
    title: ARTIFACT_PASSWORD_NEUTRAL_NAME
  }
  const actualBytes = artifactWriteRequestByteLength(protectedRequest)
  if (actualBytes > ARTIFACT_PROTECTED_PAGE_MAX_BYTES) {
    throw new ArtifactProtectedPageTooLargeError(actualBytes, ARTIFACT_PROTECTED_PAGE_MAX_BYTES)
  }
  return {
    request: protectedRequest,
    envelope,
    displayName: request.fileName,
    sourceContentType: request.contentType
  }
}
