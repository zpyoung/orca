import { build } from 'esbuild'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..')
const RELAY_HANDLER = 'src/relay/fork-native-chat-relay/native-chat-handler.ts'
const POST_NODE_18_APIS = [
  /\.toReversed\(/,
  /\.toSorted\(/,
  /\.toSpliced\(/,
  /\.with\(/,
  /\.isWellFormed\(/,
  /\.toWellFormed\(/,
  /Object\.groupBy/,
  /Map\.groupBy/,
  /Array\.fromAsync/,
  /Promise\.withResolvers/
]

async function bundleRelayHandler(): Promise<{ source: string; inputs: string[] }> {
  const result = await build({
    absWorkingDir: REPO_ROOT,
    entryPoints: [RELAY_HANDLER],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    write: false,
    metafile: true,
    external: ['node-pty', '@parcel/watcher', 'electron'],
    logLevel: 'silent'
  })
  return {
    source: result.outputFiles.map((file) => file.text).join('\n'),
    inputs: Object.keys(result.metafile.inputs)
  }
}

describe('native-chat modules bundled into the relay', () => {
  it('keeps the emitted bundle Electron-free and Node 18 compatible', async () => {
    const { source } = await bundleRelayHandler()

    expect(source).not.toMatch(/require\(["']electron["']\)/)
    expect(POST_NODE_18_APIS.filter((api) => api.test(source))).toEqual([])
  })

  it('bundles the relay copy rather than the WSL-gated desktop reader', async () => {
    const { inputs } = await bundleRelayHandler()

    expect(inputs).toContain(
      'src/main/native-chat/fork-native-chat-relay/transcript-tail-reader.ts'
    )
    expect(inputs).not.toContain('src/main/native-chat/transcript-tail-reader.ts')
    expect(inputs).toContain('src/relay/fork-native-chat-relay/native-chat-outbox.ts')
    expect(inputs).toContain('src/main/ai-vault/session-scanner-discovery.ts')
    expect(inputs.length).toBeGreaterThan(15)
  })
})
