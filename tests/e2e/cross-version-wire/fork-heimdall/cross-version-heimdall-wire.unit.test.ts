import { beforeAll, describe, expect, it } from 'vitest'
import { HEIMDALL_METHODS } from '../../../../src/main/runtime/rpc/methods/fork-heimdall/heimdall'
import { HEIMDALL_COMMANDS_RUNTIME_CAPABILITY } from '../../../../src/shared/fork-heimdall/capability'
import { RUNTIME_CAPABILITIES } from '../../../../src/shared/protocol-version'
import {
  importReleaseCheckoutModule,
  materializeReleaseCheckout,
  resolveBaselineReleaseRef
} from '../release-checkout'

const SUITE_TIMEOUT_MS = 180_000
let baselineMethodNames: string[]
let baselineCapabilities: string[]

function methodNames(methods: unknown): string[] {
  if (!Array.isArray(methods)) {
    throw new Error('Cross-version Heimdall harness found no RPC method registry')
  }
  return methods.flatMap((method) => {
    if (!method || typeof method !== 'object') {
      return []
    }
    const name = Reflect.get(method, 'name')
    return typeof name === 'string' ? [name] : []
  })
}

beforeAll(async () => {
  const baseline = await materializeReleaseCheckout(resolveBaselineReleaseRef())
  const [registry, protocol] = await Promise.all([
    importReleaseCheckoutModule(baseline, '/src/main/runtime/rpc/methods/index.ts'),
    importReleaseCheckoutModule(baseline, '/src/shared/protocol-version.ts')
  ])
  baselineMethodNames = methodNames(registry.ALL_RPC_METHODS)
  baselineCapabilities = Array.isArray(protocol.RUNTIME_CAPABILITIES)
    ? (protocol.RUNTIME_CAPABILITIES as string[])
    : []
}, SUITE_TIMEOUT_MS)

describe('Heimdall cross-version wire registration', () => {
  it('keeps every Heimdall method published by the moving release baseline', () => {
    const baselineHeimdall = baselineMethodNames.filter((name) => name.startsWith('heimdall:'))
    expect(baselineHeimdall.length).toBeGreaterThan(0)
    expect(methodNames(HEIMDALL_METHODS)).toEqual(expect.arrayContaining(baselineHeimdall))
  })

  it('keeps command capability advertisement aligned with method registration in both builds', () => {
    expect(baselineMethodNames.includes('heimdall:command')).toBe(
      baselineCapabilities.includes(HEIMDALL_COMMANDS_RUNTIME_CAPABILITY)
    )
    expect(methodNames(HEIMDALL_METHODS)).toContain('heimdall:command')
    expect(RUNTIME_CAPABILITIES).toContain(HEIMDALL_COMMANDS_RUNTIME_CAPABILITY)
  })
})
