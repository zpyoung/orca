import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The relay bundles these modules and runs them on the user's remote host, whose
// enforced floor is Node 18 (MIN_NODE_MAJOR, src/main/ssh/ssh-remote-node-toolchain-probe.ts)
// and which has no Electron. esbuild downlevels syntax but not runtime APIs, so a
// newer built-in reaches the host intact and throws there instead of here.

const REPO_ROOT = resolve(__dirname, '..', '..', '..')

/** Entry points the relay's native-chat handler pulls in. Naming only
 *  transcript-watch.ts would leave the handler and its own modules unguarded. */
const RELAY_ENTRY_POINTS = [
  'src/relay/native-chat-handler.ts',
  'src/relay/native-chat-outbox.ts',
  'src/main/native-chat/transcript-watch.ts',
  'src/main/native-chat/transcript-wire-budget.ts'
]

// `import type` erases, so a type-only edge contributes no runtime code.
const VALUE_IMPORT = /(?<!\btype\s)from '(\.[^']+)'/g

// Built-ins newer than the Node 18 floor. Syntax-level downleveling does not
// polyfill any of them.
const POST_NODE_18_APIS = [
  /\.toReversed\(/,
  /\.toSorted\(/,
  /\.toSpliced\(/,
  /\.with\(/,
  /\.isWellFormed\(/,
  /\.toWellFormed\(/,
  /\bObject\.groupBy\b/,
  /\bMap\.groupBy\b/,
  /\bArray\.fromAsync\b/,
  /\bPromise\.withResolvers\b/
]

const ELECTRON_VALUE_IMPORT = /(?<!\btype\s)from 'electron'|require\('electron'\)/

function resolveImport(fromFile: string, specifier: string): string | null {
  const base = join(dirname(fromFile), specifier)
  for (const candidate of [`${base}.ts`, join(base, 'index.ts')]) {
    if (existsSync(candidate)) {
      return candidate
    }
  }
  return null
}

/** Every source file reachable from the relay entry points by value imports. */
function collectRelayGraph(): string[] {
  const seen = new Set<string>()
  const queue = RELAY_ENTRY_POINTS.map((entry) => join(REPO_ROOT, entry))
  while (queue.length > 0) {
    const file = queue.pop()!
    if (seen.has(file) || !existsSync(file)) {
      continue
    }
    seen.add(file)
    const source = readFileSync(file, 'utf-8')
    for (const match of source.matchAll(VALUE_IMPORT)) {
      const resolved = resolveImport(file, match[1]!)
      if (resolved && !seen.has(resolved)) {
        queue.push(resolved)
      }
    }
  }
  return [...seen]
}

describe('native-chat modules bundled into the relay', () => {
  it('imports no Electron', () => {
    const offenders = collectRelayGraph().filter((file) =>
      ELECTRON_VALUE_IMPORT.test(readFileSync(file, 'utf-8'))
    )

    expect(offenders.map((file) => file.slice(REPO_ROOT.length + 1))).toEqual([])
  })

  it('uses no runtime API newer than the relay Node floor', () => {
    const offenders = collectRelayGraph().flatMap((file) => {
      const source = readFileSync(file, 'utf-8')
      return POST_NODE_18_APIS.filter((api) => api.test(source)).map(
        (api) => `${file.slice(REPO_ROOT.length + 1)}: ${api.source}`
      )
    })

    expect(offenders).toEqual([])
  })

  it('walks the graph it is meant to guard', () => {
    // Why: a broken resolver would make both guards vacuously pass.
    const graph = collectRelayGraph().map((file) => file.slice(REPO_ROOT.length + 1))

    expect(graph).toContain('src/main/native-chat/transcript-tail-reader.ts')
    expect(graph).toContain('src/main/native-chat/session-file-resolver.ts')
    expect(graph).toContain('src/main/native-chat/transcript-wire-budget.ts')
    expect(graph).toContain('src/relay/native-chat-outbox.ts')
    expect(graph).toContain('src/main/ai-vault/session-scanner-discovery.ts')
    expect(graph.length).toBeGreaterThan(15)
  })
})
