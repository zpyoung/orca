import { describe, expect, it } from 'vitest'
import {
  describeScriptApproval,
  isDeniedScriptEnvName,
  scriptApprovalDigest,
  ScriptEnvTooLargeError,
  SCRIPT_ENV_TOTAL_MAX_BYTES,
  SCRIPT_ENV_VALUE_MAX_BYTES
} from './script-env'

describe('pipeline script environment', () => {
  it('rejects protected names and allows an ordinary variable', () => {
    for (const name of [
      'PATH',
      'HOME',
      'SHELL',
      'IFS',
      'ENV',
      'BASH_ENV',
      'PS4',
      'LD_PRELOAD',
      'DYLD_INSERT_LIBRARIES',
      'ORCA_TOKEN'
    ]) {
      expect(isDeniedScriptEnvName(name)).toBe(true)
    }
    expect(isDeniedScriptEnvName('PR_TITLE')).toBe(false)
  })

  it('binds approval to command and key-sorted environment values with bounded sizes', () => {
    expect(scriptApprovalDigest({ command: 'gh pr create', env: { A: '1', B: '2' } })).toBe(
      scriptApprovalDigest({ command: 'gh pr create', env: { B: '2', A: '1' } })
    )
    expect(scriptApprovalDigest({ command: 'gh pr edit', env: { A: '1', B: '2' } })).not.toBe(
      scriptApprovalDigest({ command: 'gh pr create', env: { A: '1', B: '2' } })
    )
    expect(() => scriptApprovalDigest({ command: 'run', env: { A: 'x'.repeat(16_385) } })).toThrow(
      ScriptEnvTooLargeError
    )
    expect(() =>
      scriptApprovalDigest({
        command: 'run',
        env: {
          A: 'x'.repeat(16_384),
          B: 'y'.repeat(16_384),
          C: 'z'.repeat(16_384),
          D: 'w'.repeat(16_384)
        }
      })
    ).toThrow(ScriptEnvTooLargeError)
    expect(SCRIPT_ENV_VALUE_MAX_BYTES).toBe(16 * 1024)
    expect(SCRIPT_ENV_TOTAL_MAX_BYTES).toBe(64 * 1024)
  })

  it('shows sorted inputs while truncating long values only in the approval description', () => {
    expect(
      describeScriptApproval({ command: 'gh pr create', env: { TITLE: 'x'.repeat(250) } })
    ).toBe(`gh pr create\nTITLE=${'x'.repeat(200)}…`)
    expect(
      describeScriptApproval({ command: 'run', env: { Z_LAST: 'last', A_FIRST: 'first' } })
    ).toBe('run\nA_FIRST=first\nZ_LAST=last')
  })
})
