import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/orca-session-info-tab-test' },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (plaintext: string) => Buffer.from(plaintext, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8')
  }
}))

import { normalizeRightSidebarTab } from '../persistence'
import { UiUpdate } from '../runtime/rpc/methods/client-ui-schemas'

describe('Session Info tab main-process integration', () => {
  it('survives persisted UI normalization', () => {
    expect(normalizeRightSidebarTab('session-info')).toBe('session-info')
  })

  it('is accepted on the paired-client UI wire', () => {
    expect(UiUpdate.parse({ rightSidebarTab: 'session-info' })).toEqual({
      rightSidebarTab: 'session-info'
    })
  })
})
