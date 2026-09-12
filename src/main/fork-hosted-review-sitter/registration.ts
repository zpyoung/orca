import { ipcMain } from 'electron'
import { z } from 'zod'
import {
  HOSTED_REVIEW_AGENT_CHANNELS,
  HOSTED_REVIEW_SITTER_CHANNELS
} from '../../shared/fork-hosted-review-sitter/api'
import { isTuiAgent } from '../../shared/tui-agent-config'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { launchHostedReviewSitterFixAgent } from './agent'
import { parseHostedReviewSitterArmInput } from './definition-store'
import { createHostedReviewSitterService, type HostedReviewSitterService } from './service'

const MAX_ID_LENGTH = 4_096
const MAX_PROMPT_LENGTH = 512 * 1024

const IdRequestSchema = z.object({
  id: z.string().trim().min(1).max(MAX_ID_LENGTH)
})

const ApprovalScopeSchema = z.object({
  action: z.enum([
    'rerun-check',
    'prepare-fix',
    'publish-fix',
    'prepare-conflict-resolution',
    'publish-conflict-resolution',
    'update-branch',
    'merge',
    'enqueue'
  ]),
  headSha: z.string().trim().min(1).max(128),
  evidenceKey: z.string().min(1).max(MAX_PROMPT_LENGTH),
  preparedCommitSha: z.string().trim().min(1).max(128).optional()
})

const ApprovalRequestSchema = IdRequestSchema.extend({ scope: ApprovalScopeSchema })

const AgentLaunchSchema = z.object({
  repoId: z.string().trim().min(1).max(MAX_ID_LENGTH),
  worktreeId: z
    .string()
    .trim()
    .min(1)
    .max(MAX_ID_LENGTH * 4),
  agent: z.string().refine(isTuiAgent),
  basePrompt: z.string().min(1).max(MAX_PROMPT_LENGTH),
  title: z.string().trim().min(1).max(200).optional()
})

export function registerHostedReviewSitterIpcHandlers(
  service: HostedReviewSitterService,
  runtime: OrcaRuntimeService,
  store: Store
): void {
  for (const channel of Object.values(HOSTED_REVIEW_SITTER_CHANNELS)) {
    ipcMain.removeHandler(channel)
  }
  ipcMain.removeHandler(HOSTED_REVIEW_AGENT_CHANNELS.launchFix)

  ipcMain.handle(HOSTED_REVIEW_SITTER_CHANNELS.list, () => service.list())
  ipcMain.handle(HOSTED_REVIEW_SITTER_CHANNELS.arm, (_event, value: unknown) => {
    const input = parseHostedReviewSitterArmInput(value)
    if (!input) {
      throw new Error('Invalid hosted review sitter definition')
    }
    return service.arm(input)
  })
  ipcMain.handle(HOSTED_REVIEW_SITTER_CHANNELS.stop, (_event, value: unknown) => {
    const request = IdRequestSchema.parse(value)
    return service.stop(request.id)
  })
  ipcMain.handle(HOSTED_REVIEW_SITTER_CHANNELS.stopAll, () => service.stopAll())
  ipcMain.handle(HOSTED_REVIEW_SITTER_CHANNELS.approve, (_event, value: unknown) => {
    const request = ApprovalRequestSchema.parse(value)
    return service.approve(request.id, request.scope)
  })
  ipcMain.handle(HOSTED_REVIEW_SITTER_CHANNELS.ledger, (_event, value: unknown) => {
    const request = IdRequestSchema.parse(value)
    return service.ledger(request.id)
  })
  ipcMain.handle(HOSTED_REVIEW_AGENT_CHANNELS.launchFix, (_event, value: unknown) => {
    const input = AgentLaunchSchema.parse(value)
    if (!store.getRepo(input.repoId)) {
      throw new Error('Invalid hosted review agent repository identity')
    }
    return launchHostedReviewSitterFixAgent(runtime, store, input)
  })
}

export function startHostedReviewSitter(
  runtime: OrcaRuntimeService,
  store: Store,
  isServeMode: boolean
): HostedReviewSitterService | null {
  if (isServeMode) {
    return null
  }
  const service = createHostedReviewSitterService(runtime, store)
  registerHostedReviewSitterIpcHandlers(service, runtime, store)
  service.start()
  return service
}
