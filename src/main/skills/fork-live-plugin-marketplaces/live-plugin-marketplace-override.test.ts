import { posix as pathPosix } from 'node:path'
import { describe, expect, it } from 'vitest'
import { stablePathId, type SkillScanRoot } from '../skill-discovery-sources'
import {
  applyLivePluginSkillOverrides,
  buildPluginIdByCacheSkillsPath,
  resolveLivePluginSkillPaths
} from './live-plugin-marketplace-override'
import type { DirectoryMarketplace } from './live-plugin-marketplace-registry'

const LIVE_DIR = '/work/quirk'

function directoryMarketplace(name: string, installLocation: string): DirectoryMarketplace {
  return {
    name,
    installLocation,
    manifestPath: `${installLocation}/.claude-plugin/marketplace.json`
  }
}

function manifest(plugins: unknown[]): string {
  return JSON.stringify({ name: 'ignored-internal-name', plugins })
}

function installedPlugins(installs: Record<string, unknown[]>): string {
  return JSON.stringify({ version: 2, plugins: installs })
}

function pluginRoot(path: string, overrides: Partial<SkillScanRoot> = {}): SkillScanRoot {
  return {
    id: `claude-plugin-${stablePathId(path)}`,
    label: 'Claude plugin quirk',
    path,
    sourceKind: 'plugin',
    providers: ['claude'],
    owner: 'claude',
    pluginName: 'quirk',
    ...overrides
  }
}

describe('live plugin skill path indexing', () => {
  it('indexes every install path to its plugin id', () => {
    const index = buildPluginIdByCacheSkillsPath(
      installedPlugins({
        'quirk@quirk-dev': [
          { scope: 'user', installPath: '/cache/quirk-dev/quirk/5.9.0' },
          { scope: 'project', installPath: '/cache/quirk-dev/quirk/6.0.0' }
        ],
        'loop-toolkit@my-plugins': [{ scope: 'user', installPath: '/cache/my-plugins/loop/1.0.1' }]
      }),
      pathPosix
    )

    expect(index).toEqual(
      new Map([
        ['/cache/quirk-dev/quirk/5.9.0/skills', 'quirk@quirk-dev'],
        ['/cache/quirk-dev/quirk/6.0.0/skills', 'quirk@quirk-dev'],
        ['/cache/my-plugins/loop/1.0.1/skills', 'loop-toolkit@my-plugins']
      ])
    )
  })

  it('ignores malformed installs and non-absolute install paths', () => {
    const index = buildPluginIdByCacheSkillsPath(
      installedPlugins({
        'quirk@quirk-dev': [{ scope: 'user', installPath: 'cache/quirk' }, 'not-an-object', null],
        'broken@market': {} as unknown as unknown[]
      }),
      pathPosix
    )

    expect(index.size).toBe(0)
  })

  it('returns an empty index for absent or malformed metadata', () => {
    expect(buildPluginIdByCacheSkillsPath(null, pathPosix).size).toBe(0)
    expect(buildPluginIdByCacheSkillsPath('{ not json', pathPosix).size).toBe(0)
    expect(buildPluginIdByCacheSkillsPath('{"plugins":[]}', pathPosix).size).toBe(0)
  })
})

describe('live plugin skill path resolution', () => {
  it('resolves root and nested plugin sources, keyed by the marketplace key', () => {
    const livePaths = resolveLivePluginSkillPaths({
      marketplaces: [
        directoryMarketplace('quirk-dev', LIVE_DIR),
        directoryMarketplace('my-plugins', '/icloud/plugin-marketplace')
      ],
      manifestContents: [
        manifest([{ name: 'quirk', source: './' }]),
        manifest([
          { name: 'loop-toolkit', source: './plugins/loop-toolkit' },
          { name: 'recharge-docs', source: './plugins/recharge-docs' }
        ])
      ],
      pathApi: pathPosix
    })

    expect(livePaths).toEqual(
      new Map([
        ['quirk@quirk-dev', `${LIVE_DIR}/skills`],
        ['loop-toolkit@my-plugins', '/icloud/plugin-marketplace/plugins/loop-toolkit/skills'],
        ['recharge-docs@my-plugins', '/icloud/plugin-marketplace/plugins/recharge-docs/skills']
      ])
    )
  })

  it('rejects absolute and escaping plugin sources', () => {
    const livePaths = resolveLivePluginSkillPaths({
      marketplaces: [directoryMarketplace('quirk-dev', LIVE_DIR)],
      manifestContents: [
        manifest([
          { name: 'absolute', source: '/etc' },
          { name: 'escaping', source: '../elsewhere' },
          { name: 'escaping-deep', source: './plugins/../../elsewhere' },
          { name: 'empty', source: '' },
          { name: 'non-string', source: { source: 'github', repo: 'a/b' } },
          { name: '', source: './' }
        ])
      ],
      pathApi: pathPosix
    })

    expect(livePaths.size).toBe(0)
  })

  it('returns nothing for a missing or malformed marketplace manifest', () => {
    expect(
      resolveLivePluginSkillPaths({
        marketplaces: [
          directoryMarketplace('quirk-dev', LIVE_DIR),
          directoryMarketplace('my-plugins', '/icloud')
        ],
        manifestContents: [null, '{ not json'],
        pathApi: pathPosix
      }).size
    ).toBe(0)
  })
})

describe('live plugin skill root rewriting', () => {
  const cachePath = '/cache/quirk-dev/quirk/5.9.0/skills'
  const livePath = `${LIVE_DIR}/skills`
  const installed = installedPlugins({
    'quirk@quirk-dev': [{ scope: 'user', installPath: '/cache/quirk-dev/quirk/5.9.0' }]
  })
  const marketplaces = [directoryMarketplace('quirk-dev', LIVE_DIR)]
  const manifestContents = [manifest([{ name: 'quirk', source: './' }])]

  it('replaces the cached root with the live one and recomputes its id', () => {
    const roots = applyLivePluginSkillOverrides({
      roots: [pluginRoot(cachePath)],
      installedPluginsRaw: installed,
      marketplaces,
      manifestContents,
      pathApi: pathPosix
    })

    expect(roots).toEqual([
      {
        id: `claude-plugin-${stablePathId(livePath)}`,
        label: 'Claude plugin quirk',
        path: livePath,
        sourceKind: 'plugin',
        providers: ['claude'],
        owner: 'claude',
        pluginName: 'quirk'
      }
    ])
    expect(roots[0].id).not.toBe(pluginRoot(cachePath).id)
    expect(roots.map((root) => root.path)).not.toContain(cachePath)
  })

  it('leaves non-plugin and unmatched roots untouched', () => {
    const homeRoot: SkillScanRoot = {
      id: 'home-skills',
      label: 'Home',
      path: '/home/alice/.claude/skills',
      sourceKind: 'home',
      providers: ['claude'],
      owner: 'claude'
    }
    const otherPlugin = pluginRoot('/cache/brave-search/brave/2.0.0/skills', {
      label: 'Claude plugin brave',
      pluginName: 'brave'
    })

    const roots = applyLivePluginSkillOverrides({
      roots: [homeRoot, otherPlugin, pluginRoot(cachePath)],
      installedPluginsRaw: installed,
      marketplaces,
      manifestContents,
      pathApi: pathPosix
    })

    expect(roots.map((root) => root.path)).toEqual([homeRoot.path, otherPlugin.path, livePath])
    expect(roots[0]).toBe(homeRoot)
    expect(roots[1]).toBe(otherPlugin)
  })

  it('keys the plugin id on the marketplace key rather than the manifest name', () => {
    const roots = applyLivePluginSkillOverrides({
      roots: [pluginRoot(cachePath)],
      installedPluginsRaw: installed,
      marketplaces: [directoryMarketplace('some-other-key', LIVE_DIR)],
      manifestContents: [
        JSON.stringify({ name: 'quirk-dev', plugins: [{ name: 'quirk', source: './' }] })
      ],
      pathApi: pathPosix
    })

    expect(roots[0].path).toBe(cachePath)
  })

  it('lists the live root once when two installs of a plugin both resolve to it', () => {
    const secondCachePath = '/cache/quirk-dev/quirk/6.0.0/skills'
    const roots = applyLivePluginSkillOverrides({
      roots: [pluginRoot(cachePath), pluginRoot(secondCachePath)],
      installedPluginsRaw: installedPlugins({
        'quirk@quirk-dev': [
          { scope: 'user', installPath: '/cache/quirk-dev/quirk/5.9.0' },
          { scope: 'project', installPath: '/cache/quirk-dev/quirk/6.0.0' }
        ]
      }),
      marketplaces,
      manifestContents,
      pathApi: pathPosix
    })

    expect(roots.map((root) => root.path)).toEqual([livePath])
  })

  it('keeps the cached roots when no directory marketplace is declared', () => {
    const roots = applyLivePluginSkillOverrides({
      roots: [pluginRoot(cachePath)],
      installedPluginsRaw: installed,
      marketplaces: [],
      manifestContents: [],
      pathApi: pathPosix
    })

    expect(roots.map((root) => root.path)).toEqual([cachePath])
  })
})
