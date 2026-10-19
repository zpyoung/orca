import { EventEmitter } from 'node:events'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as loginShell from '../startup/login-shell-environment'
import type * as runProcessModule from '@orca/process-host'
import {
  __resetPersistedWindowsPathCacheForTests,
  readPersistedWindowsPathSegmentsAsync
} from '../pty/windows-environment-path'
import { resolveAgainAfterRefreshOnMissingProgram } from '../native-chat/structured-agent-command-resolution'
import { __setWindowsPathRegistryLoaderForTests } from '../pty/windows-path-registry-reader'
import {
  createStructuredAgentEnvironmentResolvers,
  structuredAgentBaseEnvironment
} from './structured-agent-shell-environment'

const { runProcessMock, spawnProcessMock } = vi.hoisted(() => ({
  runProcessMock: vi.fn(),
  spawnProcessMock: vi.fn()
}))

vi.mock('@orca/process-host', async (importOriginal) => {
  const real = await importOriginal<typeof runProcessModule>()
  return {
    ...real,
    runProcess: runProcessMock,
    // Unmocked calls spawn for real, so a stub login shell runs through the production capture.
    spawnProcess: (...args: Parameters<typeof real.spawnProcess>) =>
      spawnProcessMock(...args) ?? real.spawnProcess(...args)
  }
})

const INHERIT_ALL = { inheritAll: true, names: [] }

afterEach(loginShell.resetLoginShellEnvironmentCacheForTests)

function pathSegments(env: Record<string, string>): string[] {
  const key = Object.keys(env).find((name) => name.toLowerCase() === 'path')
  return key ? (env[key]?.split(';') ?? []) : []
}

/** A powershell.exe child that prints the env it was given plus one profile-only variable, or,
 *  when `failed`, exits without printing it, as a profile that errors does. */
function fakePowerShell(spec: { env: NodeJS.ProcessEnv }, failed = false): EventEmitter {
  const stdout = new EventEmitter()
  const child = Object.assign(new EventEmitter(), {
    stdin: Object.assign(new EventEmitter(), { end: () => {} }),
    stdout,
    stderr: Object.assign(new EventEmitter(), { resume: () => {} }),
    kill: () => true
  })
  const printed = JSON.stringify({ ...spec.env, PROFILE_ONLY: '1' })
  setImmediate(() => {
    if (!failed) {
      stdout.emit(
        'data',
        Buffer.from(`__ORCA_LOGIN_SHELL_ENV_START__${printed}__ORCA_LOGIN_SHELL_ENV_END__`)
      )
    }
    child.emit('close', failed ? 1 : 0)
  })
  return child
}

/** Windows without the registry addon (an Orca server slot); `savedPath` is each key's saved
 *  Path value, null when the key has none, answered the way reg.exe answers. */
async function withSimulatedWindowsServer(
  savedPath: (key: string) => string | null,
  run: () => Promise<void>
): Promise<void> {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  __setWindowsPathRegistryLoaderForTests(() => {
    throw new Error('Cannot find module @orca/windows-registry')
  })
  runProcessMock.mockImplementation(async ({ args }: { args: string[] }) => {
    const key = args[1] ?? ''
    const path = savedPath(key)
    if (path === null && args.includes('/v')) {
      const stderr = 'ERROR: The system was unable to find the specified registry key or value.'
      return { code: 1, signal: null, timedOut: false, stdout: '', stderr }
    }
    const lines = ['', key, '    TEMP    REG_EXPAND_SZ    %USERPROFILE%\\AppData\\Local\\Temp']
    if (path !== null) {
      lines.push(`    Path    REG_EXPAND_SZ    ${path}`)
    }
    return {
      code: 0,
      signal: null,
      timedOut: false,
      stderr: '',
      stdout: [...lines, ''].join('\r\n')
    }
  })
  spawnProcessMock.mockImplementation(fakePowerShell)
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    await run()
  } finally {
    vi.useRealTimers()
    runProcessMock.mockReset()
    spawnProcessMock.mockReset()
    __setWindowsPathRegistryLoaderForTests()
    __resetPersistedWindowsPathCacheForTests()
    loginShell.resetLoginShellEnvironmentCacheForTests()
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
  }
}

const shellEnv = {
  PATH: '/shell/bin',
  LANG: 'en_US.UTF-8',
  SSH_AUTH_SOCK: '/tmp/agent.sock',
  CODEX_LB_API_KEY: 'lb-key',
  ANTHROPIC_API_KEY: 'shell-key',
  CLAUDE_CONFIG_DIR: '/shell/claude',
  UNSET: undefined
}

const processEnv = { PATH: '/orca/bin', HOME: '/home/me', ORCA_USER_DATA_PATH: '/orca' }

describe('structuredAgentBaseEnvironment', () => {
  it('is the whole shell snapshot, and nothing else, when inheriting all', () => {
    expect(
      structuredAgentBaseEnvironment({
        shellEnv,
        policy: INHERIT_ALL,
        processEnv,
        platform: 'darwin'
      })
    ).toEqual({
      PATH: '/shell/bin',
      LANG: 'en_US.UTF-8',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      CODEX_LB_API_KEY: 'lb-key',
      ANTHROPIC_API_KEY: 'shell-key',
      CLAUDE_CONFIG_DIR: '/shell/claude'
    })
  })

  it('passes only the baseline and listed shell names over Orca env when off', () => {
    expect(
      structuredAgentBaseEnvironment({
        shellEnv,
        policy: { inheritAll: false, names: ['CODEX_LB_API_KEY'] },
        processEnv,
        platform: 'darwin'
      })
    ).toEqual({
      PATH: '/shell/bin',
      HOME: '/home/me',
      ORCA_USER_DATA_PATH: '/orca',
      LANG: 'en_US.UTF-8',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      CODEX_LB_API_KEY: 'lb-key'
    })
  })

  it('matches names case-insensitively on Windows without duplicating Path', () => {
    expect(
      structuredAgentBaseEnvironment({
        shellEnv: { PATH: 'C:\\shell', codex_lb_api_key: 'lb-key' },
        policy: { inheritAll: false, names: ['CODEX_LB_API_KEY'] },
        processEnv: { Path: 'C:\\orca', USERPROFILE: 'C:\\Users\\me' },
        platform: 'win32'
      })
    ).toEqual({ PATH: 'C:\\shell', USERPROFILE: 'C:\\Users\\me', codex_lb_api_key: 'lb-key' })
  })
})

describe('createStructuredAgentEnvironmentResolvers', () => {
  it("gives every agent the same base, with each agent's own overlay on it", async () => {
    const resolvers = createStructuredAgentEnvironmentResolvers({
      resolveEnvironment: async () => ({ PATH: '/shell/bin', SHELL_ONLY: '1' }),
      resolveShellEnvironmentPolicy: () => INHERIT_ALL,
      resolveAgentLaunchEnv: (agent): Record<string, string> =>
        agent === 'codex' ? { CODEX_PROFILE: 'p' } : {}
    })
    expect(await resolvers.resolveBaseEnvironment()).toEqual({
      PATH: '/shell/bin',
      SHELL_ONLY: '1'
    })
    expect(await resolvers.resolveAgentEnvironment('claude')).toEqual({
      PATH: '/shell/bin',
      SHELL_ONLY: '1'
    })
    expect(await resolvers.resolveAgentEnvironment('codex')).toEqual({
      PATH: '/shell/bin',
      SHELL_ONLY: '1',
      CODEX_PROFILE: 'p'
    })
  })
})
