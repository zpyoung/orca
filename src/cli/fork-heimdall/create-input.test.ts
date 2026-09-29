import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  HEIMDALL_ENROLL_OWNER_RUNTIME_CAPABILITY,
  HEIMDALL_HOSTED_REVIEW_DERIVED_PAYLOAD_RUNTIME_CAPABILITY,
  HEIMDALL_OBJECTIVE_ROLE_LAUNCH_RUNTIME_CAPABILITY,
  HEIMDALL_PARALLEL_EXECUTION_RUNTIME_CAPABILITY
} from '../../shared/fork-heimdall/capability'
import { OBJECTIVE_GATE_DEFAULT_TIMEOUT_SECONDS } from '../../shared/fork-heimdall-objective/contract-types'
import { REPEATED_FLAG_SEPARATOR } from '../args'
import {
  assertHeimdallCreateCapabilities,
  buildHeimdallCreateCandidate,
  buildHeimdallEnrollInput
} from './create-input'

const temporaryDirectories: string[] = []

async function makeDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'heimdall-create-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('Heimdall create input builder', () => {
  it('uses renderer objective defaults and derives workspace values at enrollment', () => {
    const candidate = buildHeimdallCreateCandidate(
      new Map([['objective', 'Ship the report export']]),
      '/repo',
      'objective'
    )
    if (candidate.kind !== 'objective') {
      throw new Error('Expected an objective candidate')
    }

    expect(candidate).toMatchObject({
      worktreeSelector: 'active',
      budget: { wallClockActiveMs: 14_400_000, turns: 40 },
      capabilities: { plan: 'gated', implement: 'on', review: 'on', check: 'on', land: 'on' },
      kindPayload: {
        objectiveText: 'Ship the report export',
        tier: 'standard',
        landingBar: 'files-on-disk',
        lanesEnabled: true,
        maxConcurrency: 3,
        workspaceKind: 'git',
        writeTerritory: ['**'],
        roleAgents: {},
        sitterOverrides: {}
      }
    })
    expect(
      buildHeimdallEnrollInput(
        candidate,
        {
          repoId: 'repo-1',
          worktreeId: 'folder:notes',
          workspaceKind: 'folder'
        },
        [
          HEIMDALL_PARALLEL_EXECUTION_RUNTIME_CAPABILITY,
          HEIMDALL_OBJECTIVE_ROLE_LAUNCH_RUNTIME_CAPABILITY
        ]
      )
    ).toMatchObject({
      repoId: 'repo-1',
      worktreeId: 'folder:notes',
      kindPayload: { workspaceKind: 'folder', maxConcurrency: 1 }
    })
    const legacy = buildHeimdallEnrollInput(
      candidate,
      {
        repoId: 'repo-1',
        worktreeId: 'wt-1',
        workspaceKind: 'git'
      },
      []
    )
    expect(legacy.kindPayload).toMatchObject({ maxConcurrency: 1 })
    expect(legacy.kindPayload).not.toHaveProperty('lanesEnabled')
  })
  it('derives the default land capability from the selected landing bar', () => {
    const fromFlag = buildHeimdallCreateCandidate(
      new Map([
        ['objective', 'Ship it'],
        ['landing-bar', 'merged']
      ]),
      '/repo',
      'objective'
    )
    if (fromFlag.kind !== 'objective') {
      throw new Error('Expected an objective candidate')
    }
    expect(fromFlag.capabilities.land).toBe('gated')

    const fromSpec = buildHeimdallCreateCandidate(
      new Map([
        [
          'spec',
          JSON.stringify({
            kindPayload: { objectiveText: 'Ship it', landingBar: 'pushed-ref' }
          })
        ]
      ]),
      '/repo',
      'objective'
    )
    if (fromSpec.kind !== 'objective') {
      throw new Error('Expected an objective candidate')
    }
    expect(fromSpec.capabilities.land).toBe('gated')
    const specCapability = buildHeimdallCreateCandidate(
      new Map([
        [
          'spec',
          JSON.stringify({
            capabilities: { land: 'on' },
            kindPayload: { objectiveText: 'Ship it', landingBar: 'merged' }
          })
        ]
      ]),
      '/repo',
      'objective'
    )
    if (specCapability.kind !== 'objective') {
      throw new Error('Expected an objective candidate')
    }
    expect(specCapability.capabilities.land).toBe('on')

    const explicitCapability = buildHeimdallCreateCandidate(
      new Map([
        [
          'spec',
          JSON.stringify({
            kindPayload: { objectiveText: 'Ship it', landingBar: 'pushed-ref' }
          })
        ],
        ['cap', 'land=on']
      ]),
      '/repo',
      'objective'
    )
    if (explicitCapability.kind !== 'objective') {
      throw new Error('Expected an objective candidate')
    }
    expect(explicitCapability.capabilities.land).toBe('on')
  })

  it('deep-merges spec fields while explicit flags win for scalars and nested maps', async () => {
    const directory = await makeDirectory()
    const specPath = join(directory, 'spec.json')
    await writeFile(
      specPath,
      JSON.stringify({
        capabilities: { plan: 'on', implement: 'off' },
        budget: { turns: 12 },
        kindPayload: {
          objectiveText: 'Spec objective',
          roleAgents: { planner: 'codex', reviewer: 'claude' },
          sitterOverrides: { merge: 'gated' },
          writeTerritory: ['src/**']
        }
      }),
      'utf8'
    )
    const flags = new Map<string, string | boolean>([
      ['spec', `@${specPath}`],
      ['objective', 'Flag objective wins'],
      ['hours', '2'],
      ['cap', ['plan=off', 'land=gated'].join(REPEATED_FLAG_SEPARATOR)],
      ['role-agent', ['planner=claude', 'integrator=codex'].join(REPEATED_FLAG_SEPARATOR)],
      ['territory', ['src/**', 'tests/**'].join(REPEATED_FLAG_SEPARATOR)],
      ['no-lanes', true],
      ['gate', ['lint=pnpm lint', 'unit=pnpm test'].join(REPEATED_FLAG_SEPARATOR)]
    ])

    const candidate = buildHeimdallCreateCandidate(flags, directory, 'objective')
    if (candidate.kind !== 'objective') {
      throw new Error('Expected an objective candidate')
    }
    expect(candidate).toMatchObject({
      budget: { wallClockActiveMs: 7_200_000, turns: 12 },
      capabilities: { plan: 'off', implement: 'off', review: 'on', check: 'on', land: 'gated' },
      kindPayload: {
        objectiveText: 'Flag objective wins',
        lanesEnabled: false,
        writeTerritory: ['src/**', 'tests/**'],
        roleAgents: { planner: 'claude', reviewer: 'claude', integrator: 'codex' },
        sitterOverrides: { merge: 'gated' },
        gates: [
          {
            name: 'lint',
            command: 'pnpm lint',
            timeoutSeconds: OBJECTIVE_GATE_DEFAULT_TIMEOUT_SECONDS
          },
          {
            name: 'unit',
            command: 'pnpm test',
            timeoutSeconds: OBJECTIVE_GATE_DEFAULT_TIMEOUT_SECONDS
          }
        ]
      }
    })
  })

  it('reads objective and plan text files relative to cwd', async () => {
    const directory = await makeDirectory()
    await writeFile(join(directory, 'objective.txt'), 'Write a stable exporter.\n', 'utf8')
    await writeFile(join(directory, 'plan.md'), '# Existing approved plan\n', 'utf8')
    const candidate = buildHeimdallCreateCandidate(
      new Map([
        ['objective-file', 'objective.txt'],
        ['plan-file', 'plan.md']
      ]),
      directory,
      'objective'
    )
    if (candidate.kind !== 'objective') {
      throw new Error('Expected an objective candidate')
    }
    expect(candidate.kindPayload.objectiveText).toBe('Write a stable exporter.')
    expect(candidate.kindPayload.existingPlan).toBe('# Existing approved plan')
  })

  it('uses hosted-review renderer defaults and requires the derived-payload capability', () => {
    const candidate = buildHeimdallCreateCandidate(new Map(), '/repo', 'hosted-review')
    expect(candidate).toMatchObject({
      worktreeSelector: 'active',
      budget: { wallClockActiveMs: 14_400_000, turns: null },
      capabilities: {
        updateBranch: 'off',
        resolveConflicts: 'off',
        fixChecks: 'off',
        merge: 'off'
      },
      kindPayload: { branchUpdateMode: 'merge-base-update', mergeMethod: null }
    })
    const workspace = { repoId: 'repo-1', worktreeId: 'wt-1', workspaceKind: 'git' as const }
    const input = buildHeimdallEnrollInput(candidate, workspace, [
      HEIMDALL_HOSTED_REVIEW_DERIVED_PAYLOAD_RUNTIME_CAPABILITY
    ])
    expect(input.kindPayload).toEqual({ branchUpdateMode: 'merge-base-update', mergeMethod: null })
    expect(() => buildHeimdallEnrollInput(candidate, workspace, [])).toThrow(
      /host-derived hosted-review enrollment/
    )
  })

  it('deep-merges hosted-review spec fields while CLI flags take precedence', () => {
    const candidate = buildHeimdallCreateCandidate(
      new Map([
        [
          'spec',
          JSON.stringify({
            capabilities: { merge: 'gated' },
            budget: { turns: 16 },
            kindPayload: { branchUpdateMode: 'merge-base-update', mergeMethod: 'rebase' }
          })
        ],
        ['branch-update', 'rebase'],
        ['merge-method', 'default'],
        ['cap', 'merge=on'],
        ['hours', 'none']
      ]),
      '/repo',
      'hosted-review'
    )
    expect(candidate).toMatchObject({
      capabilities: { updateBranch: 'off', resolveConflicts: 'off', fixChecks: 'off', merge: 'on' },
      budget: { wallClockActiveMs: null, turns: 16 },
      kindPayload: { branchUpdateMode: 'rebase', mergeMethod: null }
    })
  })

  it('refuses legacy hosted-review enrollment even when spec supplies identity fields', () => {
    const candidate = buildHeimdallCreateCandidate(
      new Map([
        [
          'spec',
          JSON.stringify({
            kindPayload: {
              branch: 'feature/report',
              provider: 'github',
              reviewNumber: 17,
              reviewUrl: 'https://github.com/acme/repo/pull/17'
            }
          })
        ]
      ]),
      '/repo',
      'hosted-review'
    )
    expect(() =>
      buildHeimdallEnrollInput(
        candidate,
        {
          repoId: 'repo-1',
          worktreeId: 'wt-1',
          workspaceKind: 'git'
        },
        []
      )
    ).toThrow(/host-derived hosted-review enrollment/)
    const capableInput = buildHeimdallEnrollInput(
      candidate,
      {
        repoId: 'repo-1',
        worktreeId: 'wt-1',
        workspaceKind: 'git'
      },
      [HEIMDALL_HOSTED_REVIEW_DERIVED_PAYLOAD_RUNTIME_CAPABILITY]
    )
    expect(capableInput.kindPayload).not.toHaveProperty('branch')
    expect(() =>
      buildHeimdallCreateCandidate(new Map([['cap', 'unknown=on']]), '/repo', 'hosted-review')
    ).toThrow(/unknown hosted-review capability/)
  })

  it('rejects empty repeated overrides rather than retaining broader defaults', () => {
    for (const [flag, value] of [
      ['cap', ''],
      ['territory', ''],
      ['role-agent', ''],
      ['gate', ''],
      ['cap', `plan=off${REPEATED_FLAG_SEPARATOR}`],
      ['territory', `src/**${REPEATED_FLAG_SEPARATOR}`]
    ]) {
      expect(() =>
        buildHeimdallCreateCandidate(
          new Map([
            ['objective', 'Ship it'],
            [flag, value]
          ]),
          '/repo',
          'objective'
        )
      ).toThrow(new RegExp(`--${flag}`))
    }
  })

  it('accepts only plain decimal hours, matching the budget command', () => {
    const build = (hours: string): unknown =>
      buildHeimdallCreateCandidate(
        new Map([
          ['objective', 'Ship it'],
          ['hours', hours]
        ]),
        '/repo',
        'objective'
      )
    expect(build('1.1')).toMatchObject({ budget: { wallClockActiveMs: 3_960_000 } })
    for (const hours of ['0x10', '1e3', ' 2 ', '0', '-1']) {
      expect(() => build(hours)).toThrow(/--hours must be a positive number or none/)
    }
  })

  it('gates owner enrollment on runtime support and defaults owner intervention to gated', () => {
    const candidate = buildHeimdallCreateCandidate(
      new Map([
        ['objective', 'Ship it'],
        ['owner', 'claude'],
        ['owner-model', 'opus'],
        ['owner-effort', 'high']
      ]),
      '/repo',
      'objective'
    )
    expect(candidate).toMatchObject({
      owner: { agent: 'claude', model: 'opus', effort: 'high' },
      ownerInterventionCapability: 'gated'
    })
    const raised = buildHeimdallCreateCandidate(
      new Map([
        ['objective', 'Ship it'],
        ['owner', 'claude'],
        ['cap', 'owner-intervention=on']
      ]),
      '/repo',
      'objective'
    )
    expect(raised).toMatchObject({ ownerInterventionCapability: 'on' })
    expect(() => assertHeimdallCreateCapabilities(candidate, [])).toThrow(
      /does not support Heimdall owner enrollment/
    )
    expect(() =>
      assertHeimdallCreateCapabilities(candidate, [HEIMDALL_ENROLL_OWNER_RUNTIME_CAPABILITY])
    ).not.toThrow()
  })
})
