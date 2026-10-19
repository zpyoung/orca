import { beforeEach, describe, expect, it, vi } from 'vitest'
import { retireAutomationLaunchModelsMissingFromDiscovery } from './retire-automation-launch-models'

const list = vi.fn()
const listForTarget = vi.fn()
const update = vi.fn()
const resolveAutomationModelDiscoveryHostKey = vi.fn()

vi.mock('./automation-model-discovery-host-key', () => ({
  resolveAutomationModelDiscoveryHostKey: (automation: unknown) =>
    resolveAutomationModelDiscoveryHostKey(automation)
}))

vi.mock('@/components/automations/automation-host-client', () => ({
  listAutomationsForTarget: (target: unknown) => {
    listForTarget(target)
    return list()
  },
  updateAutomationForTarget: (automation: unknown, updates: unknown) => update(automation, updates)
}))

beforeEach(() => {
  list.mockReset()
  listForTarget.mockReset()
  update.mockReset().mockResolvedValue(undefined)
  resolveAutomationModelDiscoveryHostKey.mockReset().mockReturnValue('local')
})

describe('retireAutomationLaunchModelsMissingFromDiscovery', () => {
  it('drops only stale models for authoritative catalogs', async () => {
    list.mockResolvedValue([
      {
        id: 'stale',
        agentId: 'grok',
        launchOverrides: {
          model: 'retired',
          optionValues: { effort: 'high' }
        }
      },
      { id: 'live', agentId: 'grok', launchOverrides: { model: 'grok-4.5' } },
      { id: 'other', agentId: 'claude', launchOverrides: { model: 'retired' } }
    ])

    await retireAutomationLaunchModelsMissingFromDiscovery('grok', 'local', [
      { id: 'grok-4.5', label: 'Grok 4.5', options: [] }
    ])

    expect(update).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ id: 'stale' }), {
      launchOverrides: {
        optionValues: { effort: 'high' }
      }
    })
  })

  it('lists the authority serving the probed host, not a focused server', async () => {
    list.mockResolvedValue([])
    await retireAutomationLaunchModelsMissingFromDiscovery('grok', 'runtime:env-7', [
      { id: 'grok-4.5', label: 'Grok 4.5', options: [] }
    ])
    await retireAutomationLaunchModelsMissingFromDiscovery('grok', 'ssh:build-box', [
      { id: 'grok-4.5', label: 'Grok 4.5', options: [] }
    ])

    expect(listForTarget).toHaveBeenNthCalledWith(1, {
      kind: 'environment',
      environmentId: 'env-7'
    })
    expect(listForTarget).toHaveBeenNthCalledWith(2, { kind: 'local' })
  })

  it('keeps models an automation on another host still resolves', async () => {
    list.mockResolvedValue([
      { id: 'remote', agentId: 'grok', launchOverrides: { model: 'retired' } }
    ])
    resolveAutomationModelDiscoveryHostKey.mockReturnValue('ssh:build-box')

    await retireAutomationLaunchModelsMissingFromDiscovery('grok', 'local', [
      { id: 'grok-4.6', label: 'Grok 4.6', options: [] }
    ])

    expect(update).not.toHaveBeenCalled()
  })

  it('shares one pass across concurrent callers with the same probe result', async () => {
    list.mockResolvedValue([])
    const models = [{ id: 'grok-4.7', label: 'Grok 4.7', options: [] }]

    await Promise.all([
      retireAutomationLaunchModelsMissingFromDiscovery('grok', 'local', models),
      retireAutomationLaunchModelsMissingFromDiscovery('grok', 'local', models)
    ])

    expect(list).toHaveBeenCalledTimes(1)
  })

  it('ignores empty results and non-authoritative catalogs', async () => {
    await retireAutomationLaunchModelsMissingFromDiscovery('grok', 'local', [])
    await retireAutomationLaunchModelsMissingFromDiscovery('claude', 'local', [
      { id: 'sonnet', label: 'Sonnet', options: [] }
    ])
    expect(list).not.toHaveBeenCalled()
  })
})
