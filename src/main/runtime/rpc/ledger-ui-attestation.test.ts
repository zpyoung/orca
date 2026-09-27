import { describe, expect, it } from 'vitest'
import { LedgerError, type LedgerRequest } from '../../../shared/ledger'
import {
  issueLedgerUiAttestation,
  verifyAndConsumeLedgerUiAttestation
} from './ledger-ui-attestation'

const request: LedgerRequest = { operation: 'file', content: { title: 'x', optional: undefined } }

describe('ledger UI attestation', () => {
  it('survives JSON wire roundtrip and binds the exact request', () => {
    const proof = JSON.parse(JSON.stringify(issueLedgerUiAttestation(request, 'secret', 1000)))
    expect(() => verifyAndConsumeLedgerUiAttestation(request, proof, 'secret', 1000)).not.toThrow()
  })

  it('rejects tampering, expiry, and replay', () => {
    const proof = issueLedgerUiAttestation(request, 'secret', 1000)
    expect(() =>
      verifyAndConsumeLedgerUiAttestation({ ...request, id: 'changed' }, proof, 'secret', 1000)
    ).toThrow(LedgerError)
    expect(() =>
      verifyAndConsumeLedgerUiAttestation(request, proof, 'secret', 31_000)
    ).toThrowError(expect.objectContaining({ code: 'ledger_ui_proof_expired' }))
    verifyAndConsumeLedgerUiAttestation(request, proof, 'secret', 1000)
    expect(() => verifyAndConsumeLedgerUiAttestation(request, proof, 'secret', 1000)).toThrowError(
      expect.objectContaining({ code: 'ledger_ui_proof_replayed' })
    )
  })
})
