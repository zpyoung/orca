import { describe, expect, it, vi } from 'vitest'

// stub electron at import time; the normalizer's module graph reaches app and safeStorage
vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/orca-ledger-right-sidebar-tab-test'
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (plaintext: string) => Buffer.from(plaintext, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8')
  }
}))

import { normalizeRightSidebarTab } from '../persistence/applying-settings/ui-selection-normalization'

describe('normalizeRightSidebarTab', () => {
  it('preserves the ledger tab across restarts', () => {
    expect(normalizeRightSidebarTab('ledger')).toBe('ledger')
  })
})
