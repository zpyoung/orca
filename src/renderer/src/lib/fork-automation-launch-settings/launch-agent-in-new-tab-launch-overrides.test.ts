import { describe, expect, it, vi } from 'vitest'
import { AGENT_LAUNCH_OVERRIDES_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import {
  mockCreateWebRuntimeSessionTerminal,
  mockIsWebRuntimeSessionActive,
  store
} from '../launch-agent-in-new-tab-test-fixture'

vi.mock('@/runtime/runtime-rpc-client', () => ({
  runtimeEnvironmentSupportsCapability: async () => true
}))
vi.mock('@/components/settings/agent-launch-settings-transport', () => ({
  hostSupportsLaunchChoices: async () => true
}))
vi.mock('@/components/settings/use-host-agent-launch-preferences', () => ({
  ensureAgentLaunchPreferences: async () => ({}),
  readAgentLaunchPreferencesForWorktree: () => ({})
}))

describe('launchAgentInNewTab structured override launches', () => {
  it('gates structured override launches on the host feature capability', async () => {
    mockIsWebRuntimeSessionActive.mockReturnValue(true)
    store.settings = {
      agentCmdOverrides: {},
      agentDefaultArgs: {},
      agentDefaultEnv: {},
      activeRuntimeEnvironmentId: 'web-runtime'
    }
    Object.assign(store.repos[0], { executionHostId: 'runtime:web-runtime' })
    const { launchAgentInNewTab } = await import('../launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      requestId: 'request-overrides',
      agent: 'claude',
      worktreeId: 'wt-1',
      sessionOptions: { model: 'sonnet' },
      agentArgs: '--verbose',
      includeSessionOptionCatalogDefaults: false
    })
    await result?.terminalCompletion

    expect(mockCreateWebRuntimeSessionTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        hostAuthorityCapability: AGENT_LAUNCH_OVERRIDES_RUNTIME_CAPABILITY,
        agentArgs: '--verbose',
        launchPreferences: { model: 'sonnet', optionValues: {} }
      })
    )
  })
})
