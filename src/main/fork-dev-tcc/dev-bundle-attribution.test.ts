import { describe, expect, it } from 'vitest'
import {
  getDevBundlePlistPatches,
  getDevHelperPlistPatches
} from '../../../config/scripts/dev-electron-bundle-identity.mjs'
import { isOrcaAttributedPrompt } from '../macos-tcc-prompt-watch'

describe('dev bundle TCC attribution', () => {
  it('counts prompts attributed to the app and helper identities emitted by the dev runner', () => {
    for (const patches of [getDevBundlePlistPatches(), getDevHelperPlistPatches()]) {
      const identifier = patches.find((patch) => patch.key === 'CFBundleIdentifier')?.value
      expect(identifier).toBeDefined()
      expect(
        isOrcaAttributedPrompt({
          service: 'kTCCServiceSystemPolicyAppData',
          accessingIdentifier: 'find',
          responsibleIdentifier: identifier ?? ''
        })
      ).toBe(true)
    }
  })

  it('does not accept arbitrary descendants of the dev bundle identity', () => {
    const identifier = getDevBundlePlistPatches().find(
      (patch) => patch.key === 'CFBundleIdentifier'
    )?.value
    expect(identifier).toBeDefined()
    expect(
      isOrcaAttributedPrompt({
        service: 'kTCCServiceSystemPolicyAppData',
        accessingIdentifier: 'find',
        responsibleIdentifier: `${identifier}.unrelated`
      })
    ).toBe(false)
  })
})
