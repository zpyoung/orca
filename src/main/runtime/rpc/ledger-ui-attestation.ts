import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto'
import type { LedgerRequest } from '../../../shared/ledger'
import { LedgerError } from '../../../shared/ledger'
import {
  ledgerUiAttestationPayload,
  type LedgerUiAttestation
} from '../../../shared/ledger-ui-attestation'

const MAX_AGE_MS = 30_000
const MAX_NONCES = 16_384
const consumedNonces = new Map<string, number>()

export function issueLedgerUiAttestation(
  request: LedgerRequest,
  deviceToken: string,
  now = Date.now()
): LedgerUiAttestation {
  const timestamp = now
  const nonce = randomBytes(18).toString('base64url')
  const mac = createHmac('sha256', deviceToken)
    .update(ledgerUiAttestationPayload(request, timestamp, nonce))
    .digest('base64url')
  return { timestamp, nonce, mac }
}

export function verifyAndConsumeLedgerUiAttestation(
  request: LedgerRequest,
  attestation: unknown,
  authenticatedCredential: string | undefined,
  now = Date.now()
): void {
  if (!authenticatedCredential || !attestation || typeof attestation !== 'object') {
    throw new LedgerError('ledger_ui_proof_invalid', 'Invalid ledger UI proof')
  }
  const candidate = attestation as Partial<LedgerUiAttestation>
  if (
    typeof candidate.timestamp !== 'number' ||
    !Number.isSafeInteger(candidate.timestamp) ||
    typeof candidate.nonce !== 'string' ||
    candidate.nonce.length < 1 ||
    candidate.nonce.length > 256 ||
    typeof candidate.mac !== 'string' ||
    candidate.mac.length < 1 ||
    candidate.mac.length > 256
  ) {
    throw new LedgerError('ledger_ui_proof_invalid', 'Invalid ledger UI proof')
  }
  if (Math.abs(now - candidate.timestamp) >= MAX_AGE_MS) {
    throw new LedgerError('ledger_ui_proof_expired', 'Ledger UI proof expired')
  }
  for (const [nonce, expires] of consumedNonces) {
    if (expires <= now) {
      consumedNonces.delete(nonce)
    }
  }
  if (consumedNonces.has(candidate.nonce)) {
    throw new LedgerError('ledger_ui_proof_replayed', 'Ledger UI proof was already used')
  }
  const expected = createHmac('sha256', authenticatedCredential)
    .update(ledgerUiAttestationPayload(request, candidate.timestamp, candidate.nonce))
    .digest('base64url')
  const actual = Buffer.from(candidate.mac)
  const wanted = Buffer.from(expected)
  if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) {
    throw new LedgerError('ledger_ui_proof_invalid', 'Invalid ledger UI proof')
  }
  if (consumedNonces.size >= MAX_NONCES) {
    throw new LedgerError('ledger_ui_proof_capacity', 'Ledger UI proof replay guard is at capacity')
  }
  consumedNonces.set(candidate.nonce, candidate.timestamp + MAX_AGE_MS)
}
