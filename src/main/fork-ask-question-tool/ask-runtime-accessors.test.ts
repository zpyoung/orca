import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OrcaRuntimeService } from '../runtime/orca-runtime'

// Why: getAskServices() resolves the electron app lazily via require('electron'), so outside a
// real Electron process require('electron') just returns the binary's path string — stub the
// module's own require.cache entry, since vi.mock only intercepts the ESM import graph.
const require = createRequire(import.meta.url)
const electronModulePath = require.resolve('electron')
const mockElectronApp = { userDataPath: '' }

require.cache[electronModulePath] = {
  id: electronModulePath,
  filename: electronModulePath,
  loaded: true,
  exports: { app: { getPath: () => mockElectronApp.userDataPath } }
} as unknown as NodeJS.Module

describe('OrcaRuntimeService.getAskServices', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-ask-runtime-'))
    mockElectronApp.userDataPath = root
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('delegates to the same memoized service bundle across calls', () => {
    const runtime = new OrcaRuntimeService()

    const services = runtime.getAskServices()
    expect(runtime.getAskServices()).toBe(services)
  })

  it('gives each runtime instance its own service bundle', () => {
    const a = new OrcaRuntimeService()
    const b = new OrcaRuntimeService()

    expect(a.getAskServices()).not.toBe(b.getAskServices())
  })
})
