import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Every production source file this feature owns, as of this writing. A file added to the
// feature later isn't covered until it's added here — this is a static list, not a live scan.
const FEATURE_FILES = [
  'src/shared/pipeline-template-graph-rules.ts',
  'src/shared/pipeline-template-raw-map.ts',
  'src/shared/pipeline-template-starter.ts',
  'src/shared/pipeline-template-structural-rules.ts',
  'src/shared/pipeline-template-types.ts',
  'src/shared/pipeline-template-unknown-keys.ts',
  'src/shared/pipeline-template-value-rules.ts',
  'src/shared/pipeline-template-yaml-parse.ts',
  'src/shared/pipeline-template.ts',
  'src/shared/pipeline-run-snapshot.ts',
  'src/shared/pipeline-dispatch-prompt.ts',
  'src/main/pipelines/pipeline-starter-template.ts',
  'src/main/pipelines/pipeline-template-files.ts',
  'src/main/ipc/pipeline-subscription.ts',
  'src/main/ipc/pipeline-templates.ts',
  'src/main/runtime/pipelines/pipeline-branch-name.ts',
  'src/main/runtime/pipelines/pipeline-checkpoint-capture.ts',
  'src/main/runtime/pipelines/pipeline-checkpoint-git.ts',
  'src/main/runtime/pipelines/pipeline-checkpoint-restore-obstructions.ts',
  'src/main/runtime/pipelines/pipeline-checkpoint-restore.ts',
  'src/main/runtime/pipelines/pipeline-checkpoint-ssh-backend.ts',
  'src/main/runtime/pipelines/pipeline-checkpoint-support-gate.ts',
  'src/main/runtime/pipelines/pipeline-checkpoint.ts',
  'src/main/runtime/pipelines/pipeline-driver-dispatch.ts',
  'src/main/runtime/pipelines/pipeline-driver-failure.ts',
  'src/main/runtime/pipelines/pipeline-driver-node-graph.ts',
  'src/main/runtime/pipelines/pipeline-driver-poll.ts',
  'src/main/runtime/pipelines/pipeline-driver-retry.ts',
  'src/main/runtime/pipelines/pipeline-driver-run-context.ts',
  'src/main/runtime/pipelines/pipeline-driver-stage-classify.ts',
  'src/main/runtime/pipelines/pipeline-driver-test-support.ts',
  'src/main/runtime/pipelines/pipeline-driver-types.ts',
  'src/main/runtime/pipelines/pipeline-driver-verified-stop.ts',
  'src/main/runtime/pipelines/pipeline-driver.ts',
  'src/main/runtime/pipelines/pipeline-instantiation-host.ts',
  'src/main/runtime/pipelines/pipeline-instantiation-worktree.ts',
  'src/main/runtime/pipelines/pipeline-instantiation.ts',
  'src/main/runtime/pipelines/pipeline-preflight-agent-command.ts',
  'src/main/runtime/pipelines/pipeline-preflight-executable-presence.ts',
  'src/main/runtime/pipelines/pipeline-preflight.ts',
  'src/main/runtime/pipelines/pipeline-run-lifecycle-registry.ts',
  'src/main/runtime/pipelines/pipeline-run-lifecycle.ts',
  'src/main/runtime/pipelines/pipeline-snapshot-publisher-assemble.ts',
  'src/main/runtime/pipelines/pipeline-snapshot-publisher.ts',
  'src/main/runtime/pipelines/stub-harness/stub-agent-launcher.ts',
  'src/main/runtime/pipelines/stub-harness/stub-harness-control-dir.ts',
  'src/main/runtime/pipelines/stub-harness/stub-harness-hold-signal.ts',
  'src/main/runtime/pipelines/stub-harness/stub-harness-outcome.ts',
  'src/main/runtime/pipelines/stub-harness/stub-harness-received-prompt.ts',
  'src/main/runtime/pipelines/stub-harness/stub-harness-script.ts',
  'src/main/runtime/pipelines/stub-harness/stub-harness.ts',
  'src/main/runtime/orchestration/pipeline-run-db-attempts.ts',
  'src/main/runtime/orchestration/pipeline-run-db-instantiate.ts',
  'src/main/runtime/orchestration/pipeline-run-db-queries.ts',
  'src/main/runtime/orchestration/pipeline-run-db-schema.ts',
  'src/main/runtime/orchestration/pipeline-run-db-types.ts',
  'src/main/runtime/orchestration/pipeline-run-db.ts',
  'src/main/runtime/rpc/methods/pipelines-schema.ts',
  'src/main/runtime/rpc/methods/pipelines-wire.ts',
  'src/main/runtime/rpc/methods/pipelines.ts',
  'src/relay/git-handler-pipeline-checkpoint.ts',
  'src/renderer/src/components/pipeline-canvas/PipelineCanvas.tsx',
  'src/renderer/src/components/pipeline-canvas/PipelineCanvasScene.tsx',
  'src/renderer/src/components/pipeline-canvas/PipelineRunControls.tsx',
  'src/renderer/src/components/pipeline-canvas/PipelineStartDialog.tsx',
  'src/renderer/src/components/pipeline-canvas/pipeline-canvas-elapsed-time.ts',
  'src/renderer/src/components/pipeline-canvas/pipeline-canvas-layout.ts',
  'src/renderer/src/components/pipeline-canvas/pipeline-canvas-node-visuals.ts',
  'src/renderer/src/components/pipeline-canvas/usePipelineRunSnapshot.ts',
  'src/renderer/src/lib/ensure-pipeline-tab.ts',
  'src/renderer/src/lib/pipeline-palette-search.ts',
  'src/renderer/src/lib/pipeline-tab-palette-activation.ts',
  'src/renderer/src/runtime/pipeline-run-client.ts',
  'src/renderer/src/store/slices/pipeline-runs.ts'
] as const

// The actual UI surfaces this feature renders — a screen, tooltip, or field per the criterion's
// wording. Backend files legitimately use "token" (shell/argv, git-plumbing tokens) and "budget"
// (internal retry-attempt ceilings) in ways that read as cost/usage words but aren't; scoping the
// broad wordlist to the render surface avoids papering over that with an allowlist of matches
// instead of a narrower, honest claim.
const UI_SURFACE_FILES = [
  'src/renderer/src/components/pipeline-canvas/PipelineCanvas.tsx',
  'src/renderer/src/components/pipeline-canvas/PipelineCanvasScene.tsx',
  'src/renderer/src/components/pipeline-canvas/PipelineRunControls.tsx',
  'src/renderer/src/components/pipeline-canvas/PipelineStartDialog.tsx',
  'src/renderer/src/components/pipeline-canvas/pipeline-canvas-elapsed-time.ts',
  'src/renderer/src/components/pipeline-canvas/pipeline-canvas-layout.ts',
  'src/renderer/src/components/pipeline-canvas/pipeline-canvas-node-visuals.ts',
  'src/renderer/src/components/pipeline-canvas/usePipelineRunSnapshot.ts'
] as const

const COST_WORDS = /\b(cost|price|pricing|budget|usage|dollar|token)s?\b/i

function readFeatureFile(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), 'utf8')
}

describe('pipeline feature — no cost surface (AC23)', () => {
  // Limits, stated plainly: this is a static grep over a fixed file list, not a rendered-DOM
  // audit — it cannot see a value assembled at runtime from unrelated parts, and it does not
  // cover files outside FEATURE_FILES. It is a floor, not a substitute for review.
  it.each(FEATURE_FILES)('%s contains no literal dollar figure', (relativePath) => {
    const source = readFeatureFile(relativePath)
    expect(source).not.toMatch(/\$\d/)
  })

  it.each(UI_SURFACE_FILES)('%s never names a cost, price, budget, usage, or token concept', (relativePath) => {
    const source = readFeatureFile(relativePath)
    expect(source).not.toMatch(COST_WORDS)
  })
})
