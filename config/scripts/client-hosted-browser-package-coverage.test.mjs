import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const projectDir = resolve(import.meta.dirname, '../..')

describe('client-hosted browser package coverage', () => {
  it('runs client-hosted Electron lifecycle coverage on the Linux package host', () => {
    const prWorkflow = readFileSync(join(projectDir, '.github/workflows/pr.yml'), 'utf8')
    const parsedWorkflow = parse(prWorkflow)
    const linuxStep = parsedWorkflow.jobs.package.steps.find(
      (step) => step.name === 'Test Linux Electron lifecycle boundary'
    )

    const required = [
      'browser-client-page-renderer-lifecycle',
      'browser-route-webrtc-egress',
      'browser-route-tcp-egress',
      'browser-route-h3-egress',
      'browser-route-dns-prefetch'
    ].map((name) => `src/main/browser/${name}.electron.test.ts`)

    expect(linuxStep.run).toContain('xvfb-run --auto-servernum')
    for (const file of required) {
      expect(linuxStep.run).toContain(file)
    }
  })

  // Why pinned: each of those files launches a full Electron stack twice under its own in-process
  // deadline. Letting the runner interleave four of them starved the probes past those deadlines,
  // which is the only way this step has ever failed.
  it('gives each Linux Electron probe the runner to itself', () => {
    const parsedWorkflow = parse(readFileSync(join(projectDir, '.github/workflows/pr.yml'), 'utf8'))
    const linuxStep = parsedWorkflow.jobs.package.steps.find(
      (step) => step.name === 'Test Linux Electron lifecycle boundary'
    )

    expect(linuxStep.run).toContain('--no-file-parallelism')
  })
})
