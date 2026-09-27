import type { WslResult } from '../../wsl/wsl-runner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const runWslProcessMock = vi.hoisted(() => vi.fn())

vi.mock('../../wsl/wsl-runner', () => ({ runWslProcess: runWslProcessMock }))

import { discoverLiveClaudePluginSkillSourcesInWsl } from './live-plugin-marketplace-sources-wsl'

const HOME_DIR = '/home/alice'
const CWD = '/work/orca'
const PLUGIN_ID = 'quirk@quirk-dev'
const CACHE_PATH = '/home/alice/.claude/plugins/cache/quirk-dev/quirk/5.9.0'
const LIVE_DIR = "/home/alice/AI Agent/quirk's marketplace"
const KAI_PLUGIN_ID = 'kai@kai-dev'
const KAI_CACHE_PATH = '/home/alice/.claude/plugins/cache/kai-dev/kai/1.0.0'
const KAI_LIVE_DIR = '/home/alice/dev/kai-marketplace'

function record(...fields: string[]): string {
  return `${fields.join('\0')}\0`
}

function present(index: number, value: string): string {
  return record('F', String(index), '1', Buffer.from(value).toString('base64'))
}

function absent(index: number): string {
  return record('F', String(index), '0', '')
}

function wslResult(stdout: string): WslResult {
  return { environmentResolved: true, code: 0, stdout, stderr: '', timedOut: false }
}

function queueResponse(_callIndex: number, stdout: string): void {
  runWslProcessMock.mockResolvedValueOnce(wslResult(stdout))
}

function metadataResponse(
  knownMarketplaces: string | null,
  installs: Record<string, string> = { [PLUGIN_ID]: CACHE_PATH }
): string {
  const installed = JSON.stringify({
    version: 2,
    plugins: Object.fromEntries(
      Object.entries(installs).map(([id, installPath]) => [id, [{ scope: 'user', installPath }]])
    )
  })
  const settings = JSON.stringify({
    enabledPlugins: Object.fromEntries(Object.keys(installs).map((id) => [id, true]))
  })
  return [
    present(0, installed),
    present(1, settings),
    absent(2),
    absent(3),
    knownMarketplaces === null ? absent(4) : present(4, knownMarketplaces)
  ].join('')
}

function directoryMarketplaces(): string {
  return JSON.stringify({
    'quirk-dev': { source: { source: 'directory', path: LIVE_DIR }, installLocation: LIVE_DIR }
  })
}

function decodeScript(callIndex: number): string {
  return (runWslProcessMock.mock.calls[callIndex]?.[0].script as string | undefined) ?? ''
}

function decodeMetadataPaths(callIndex: number): string[] {
  return Array.from(decodeScript(callIndex).matchAll(/^read_metadata \d+ (.+)$/gm), (match) =>
    (match[1] ?? '').replace(/^'|'$/g, '').replaceAll(`'\\''`, "'")
  )
}

function discover(): Promise<{ path: string }[]> {
  return discoverLiveClaudePluginSkillSourcesInWsl({
    distro: 'Ubuntu',
    homeDir: HOME_DIR,
    cwd: CWD
  })
}

describe('live Claude plugin skill sources in WSL', () => {
  beforeEach(() => runWslProcessMock.mockReset())

  it('batches known_marketplaces.json into the metadata read and stops at one call without a directory marketplace', async () => {
    queueResponse(
      0,
      metadataResponse(
        JSON.stringify({
          'brave-search': {
            source: { source: 'github', repo: 'brave/brave-search-skills' },
            installLocation: '/home/alice/.claude/plugins/marketplaces/brave-search'
          }
        })
      )
    )

    const roots = await discover()

    expect(runWslProcessMock).toHaveBeenCalledTimes(1)
    // the module slices this batch by position, so order is part of the contract
    expect(decodeMetadataPaths(0)).toEqual([
      `${HOME_DIR}/.claude/plugins/installed_plugins.json`,
      `${HOME_DIR}/.claude/settings.json`,
      `${CWD}/.claude/settings.json`,
      `${CWD}/.claude/settings.local.json`,
      `${HOME_DIR}/.claude/plugins/known_marketplaces.json`
    ])
    expect(roots.map((root) => root.path)).toEqual([`${CACHE_PATH}/skills`])
  })

  it('reads marketplace manifests in a second call and repoints the root at the live directory', async () => {
    queueResponse(0, metadataResponse(directoryMarketplaces()))
    queueResponse(1, present(0, JSON.stringify({ plugins: [{ name: 'quirk', source: './' }] })))

    const roots = await discover()

    expect(runWslProcessMock).toHaveBeenCalledTimes(2)
    expect(roots.map((root) => root.path)).toEqual([`${LIVE_DIR}/skills`])
  })

  it('keeps each marketplace manifest aligned with its own live directory', async () => {
    queueResponse(
      0,
      metadataResponse(
        JSON.stringify({
          'quirk-dev': {
            source: { source: 'directory', path: LIVE_DIR },
            installLocation: LIVE_DIR
          },
          'kai-dev': {
            source: { source: 'directory', path: KAI_LIVE_DIR },
            installLocation: KAI_LIVE_DIR
          }
        }),
        { [PLUGIN_ID]: CACHE_PATH, [KAI_PLUGIN_ID]: KAI_CACHE_PATH }
      )
    )
    queueResponse(
      1,
      [
        present(0, JSON.stringify({ plugins: [{ name: 'quirk', source: './' }] })),
        present(1, JSON.stringify({ plugins: [{ name: 'kai', source: './plugins/kai' }] }))
      ].join('')
    )

    const roots = await discover()

    expect(decodeMetadataPaths(1)).toEqual([
      `${LIVE_DIR}/.claude-plugin/marketplace.json`,
      `${KAI_LIVE_DIR}/.claude-plugin/marketplace.json`
    ])
    expect(roots.map((root) => root.path)).toEqual([
      `${LIVE_DIR}/skills`,
      `${KAI_LIVE_DIR}/plugins/kai/skills`
    ])
  })

  it('quotes an install location containing spaces and an apostrophe', async () => {
    queueResponse(0, metadataResponse(directoryMarketplaces()))
    queueResponse(1, absent(0))

    await discover()

    expect(decodeScript(1)).toContain(
      `'/home/alice/AI Agent/quirk'\\''s marketplace/.claude-plugin/marketplace.json'`
    )
    expect(runWslProcessMock.mock.calls[1]?.[0].args).toBeUndefined()
  })

  it('runs through the WSL runner as a bash script that needs no login PATH', async () => {
    queueResponse(0, metadataResponse(null))

    await discover()

    // Why assert the spec, not an argv: the runner owns --exec and the payload
    // transport now, and picking either per call site is what it exists to stop.
    expect(runWslProcessMock.mock.calls[0]?.[0]).toMatchObject({
      distro: 'Ubuntu',
      loginPath: 'none',
      shell: 'bash'
    })
  })

  it('keeps the cached root when the manifest read fails', async () => {
    queueResponse(0, metadataResponse(directoryMarketplaces()))
    runWslProcessMock.mockResolvedValueOnce({
      environmentResolved: true,
      code: null,
      stdout: '',
      stderr: '',
      timedOut: true
    } satisfies WslResult)

    const roots = await discover()

    expect(roots.map((root) => root.path)).toEqual([`${CACHE_PATH}/skills`])
  })
})
