import { posix as pathPosix } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  getKnownMarketplacesPath,
  listDirectoryMarketplaces
} from './live-plugin-marketplace-registry'

function marketplaces(entries: Record<string, unknown>): string {
  return JSON.stringify(entries)
}

describe('live plugin marketplace registry', () => {
  it('resolves the known marketplaces path under the Claude plugin directory', () => {
    expect(getKnownMarketplacesPath('/home/alice', pathPosix)).toBe(
      '/home/alice/.claude/plugins/known_marketplaces.json'
    )
  })

  it('keeps directory marketplaces and drops github and git ones', () => {
    const raw = marketplaces({
      'quirk-dev': {
        source: { source: 'directory', path: '/work/quirk' },
        installLocation: '/work/quirk'
      },
      'brave-search': {
        source: { source: 'github', repo: 'brave/brave-search-skills' },
        installLocation: '/home/alice/.claude/plugins/marketplaces/brave-search'
      },
      'agent-isles': {
        source: { source: 'git', url: 'https://example.test/agent-isles.git' },
        installLocation: '/home/alice/.claude/plugins/marketplaces/agent-isles'
      }
    })

    expect(listDirectoryMarketplaces(raw, pathPosix)).toEqual([
      {
        name: 'quirk-dev',
        installLocation: '/work/quirk',
        manifestPath: '/work/quirk/.claude-plugin/marketplace.json'
      }
    ])
  })

  it('keeps an install location containing spaces', () => {
    const installLocation = '/home/alice/Mobile Documents/AI Agent/claude/plugin-marketplace'
    const raw = marketplaces({
      'my-plugins': { source: { source: 'directory' }, installLocation }
    })

    expect(listDirectoryMarketplaces(raw, pathPosix)).toEqual([
      {
        name: 'my-plugins',
        installLocation,
        manifestPath: `${installLocation}/.claude-plugin/marketplace.json`
      }
    ])
  })

  it('drops entries whose install location is missing or not absolute', () => {
    const raw = marketplaces({
      relative: { source: { source: 'directory' }, installLocation: 'plugins/local' },
      absent: { source: { source: 'directory' } },
      'windows-drive-under-posix': {
        source: { source: 'directory' },
        installLocation: 'C:\\Users\\alice\\plugins'
      }
    })

    expect(listDirectoryMarketplaces(raw, pathPosix)).toEqual([])
  })

  it('drops entries with a missing or non-object source', () => {
    const raw = marketplaces({
      'no-source': { installLocation: '/work/quirk' },
      'string-source': { source: 'directory', installLocation: '/work/quirk' },
      'array-source': { source: ['directory'], installLocation: '/work/quirk' }
    })

    expect(listDirectoryMarketplaces(raw, pathPosix)).toEqual([])
  })

  it('returns nothing for absent, malformed, or non-object JSON', () => {
    expect(listDirectoryMarketplaces(null, pathPosix)).toEqual([])
    expect(listDirectoryMarketplaces('', pathPosix)).toEqual([])
    expect(listDirectoryMarketplaces('{ not json', pathPosix)).toEqual([])
    expect(listDirectoryMarketplaces('[]', pathPosix)).toEqual([])
    expect(listDirectoryMarketplaces('"quirk-dev"', pathPosix)).toEqual([])
  })
})
