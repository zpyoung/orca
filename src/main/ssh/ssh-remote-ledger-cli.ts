import { relative, resolve as resolvePath } from 'node:path'
import type { RuntimeStatus } from '../../shared/runtime-types'
import type { RuntimeOrchestrationEnvelope } from '../../shared/runtime-rpc-envelope'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../shared/protocol-version'
import type { RpcDispatcher } from '../runtime/rpc/dispatcher'
import type { RpcResponse } from '../runtime/rpc/core'
import { RemoteCliArgumentError, type ParsedRemoteCli } from './ssh-remote-cli-argument-error'
import { optionalRemoteCliNumber, optionalRemoteCliString } from './ssh-remote-cli-args'

const LEDGER_COMMANDS = new Set([
  'ledger file',
  'ledger list',
  'ledger show',
  'ledger edit',
  'ledger state',
  'ledger review',
  'ledger revert',
  'ledger import'
])
const POSITIONAL_ID_OPERATIONS = new Set(['show', 'edit', 'state', 'revert'])

function remoteCliBoolean(flags: ParsedRemoteCli['flags'], name: string): boolean | undefined {
  const value = optionalRemoteCliString(flags, name)
  if (value === undefined) {
    return undefined
  }
  if (value !== 'true' && value !== 'false') {
    throw new RemoteCliArgumentError('invalid_argument', `--${name} must be true or false`)
  }
  return value === 'true'
}

export async function tryDispatchRemoteLedgerCli(
  dispatcher: RpcDispatcher,
  parsed: ParsedRemoteCli,
  env: Record<string, string>,
  envelope: RuntimeOrchestrationEnvelope
): Promise<RpcResponse | null> {
  // Why: the entry id is a positional token, so only the leading two segments name the command.
  const command = parsed.commandPath.slice(0, 2).join(' ')
  const operation = parsed.commandPath[1]
  const maxSegments = POSITIONAL_ID_OPERATIONS.has(operation) ? 3 : 2
  if (!LEDGER_COMMANDS.has(command) || parsed.commandPath.length > maxSegments) {
    return null
  }

  const hasGroup = parsed.flags.has('group')
  const groupSelector = optionalRemoteCliString(parsed.flags, 'group-selector')
  const ledgerId = optionalRemoteCliString(parsed.flags, 'ledger')
  if (hasGroup && parsed.flags.has('group-selector')) {
    throw new RemoteCliArgumentError(
      'invalid_argument',
      '--group and --group-selector are mutually exclusive'
    )
  }
  if (parsed.flags.has('group-selector') && !groupSelector) {
    throw new RemoteCliArgumentError('invalid_argument', '--group-selector requires a value')
  }
  if (parsed.flags.has('ledger') && !ledgerId) {
    throw new RemoteCliArgumentError('invalid_argument', '--ledger requires a value')
  }
  const workspaceFlag = optionalRemoteCliString(parsed.flags, 'workspace')
  if (ledgerId && workspaceFlag) {
    throw new RemoteCliArgumentError(
      'invalid_argument',
      '--ledger is mutually exclusive with --workspace'
    )
  }
  if (ledgerId && (hasGroup || groupSelector)) {
    throw new RemoteCliArgumentError(
      'invalid_argument',
      '--ledger is mutually exclusive with --group and --group-selector'
    )
  }
  if (ledgerId && !['list', 'show', 'review'].includes(operation)) {
    throw new RemoteCliArgumentError(
      'invalid_argument',
      '--ledger is only supported by ledger list, show, and review'
    )
  }

  let workspaceId = workspaceFlag
  if (workspaceId === 'active' || workspaceId === 'current' || (!workspaceId && !ledgerId)) {
    const listing = await dispatchLedger(dispatcher, 'worktree.list', { limit: 10_000 })
    if (!listing.ok) {
      return listing
    }
    const cwd = resolvePath(env.ORCA_CLI_CWD || process.cwd())
    const candidates = (
      (listing.result as { worktrees?: { id?: string; path?: string }[] }).worktrees ?? []
    )
      .filter((item) => typeof item.id === 'string' && typeof item.path === 'string')
      .filter((item) => {
        const remainder = relative(resolvePath(item.path!), cwd)
        return remainder === '' || (!remainder.startsWith('..') && remainder !== '..')
      })
      .sort((a, b) => resolvePath(b.path!).length - resolvePath(a.path!).length)
    if (candidates.length === 0) {
      throw new RemoteCliArgumentError(
        'selector_not_found',
        `No Orca-managed worktree contains the current directory: ${cwd}`
      )
    }
    workspaceId = candidates[0].id
  }

  const target = {
    ...(workspaceId ? { workspaceId } : {}),
    ...(hasGroup ? { group: true } : {}),
    ...(groupSelector ? { groupSelector } : {}),
    ...(ledgerId ? { ledgerId } : {})
  }
  const content: Record<string, unknown> = {}
  const fields: Record<string, string> = {
    title: 'title',
    file: 'file',
    description: 'description',
    severity: 'severity',
    'why-deferred': 'why_deferred',
    priority: 'priority',
    'file-under-test': 'file_under_test',
    'reason-skipped': 'reason_skipped',
    context: 'context',
    recommendation: 'recommendation',
    decision: 'decision',
    consequences: 'consequences',
    status: 'status'
  }
  for (const [flag, field] of Object.entries(fields)) {
    const value = optionalRemoteCliString(parsed.flags, flag)
    if (value !== undefined) {
      content[field] = value
    }
  }
  const request: Record<string, unknown> = { operation, target }
  const id =
    optionalRemoteCliString(parsed.flags, 'id') ??
    (POSITIONAL_ID_OPERATIONS.has(operation) ? parsed.commandPath[2] : undefined)
  if (id) {
    request.id = id
  }
  const type = optionalRemoteCliString(parsed.flags, 'type')
  const state = optionalRemoteCliString(parsed.flags, 'state')
  if (operation === 'list' || operation === 'review') {
    const branch = optionalRemoteCliString(parsed.flags, 'branch')
    const reviewed = remoteCliBoolean(parsed.flags, 'reviewed')
    const stale = remoteCliBoolean(parsed.flags, 'stale')
    request.filters = {
      ...(type ? { type } : {}),
      ...(state ? { state } : {}),
      ...(reviewed !== undefined ? { reviewed } : {}),
      ...(stale !== undefined ? { stale } : {}),
      ...(workspaceFlag ? { workspaceId } : {}),
      ...(branch ? { branch } : {})
    }
  } else {
    if (type) {
      request.type = type
    }
    if (state) {
      request.state = state
    }
  }
  if (Object.keys(content).length > 0) {
    request.content = content
  }
  const ifRevision = optionalRemoteCliNumber(parsed.flags, 'if-revision')
  if (ifRevision !== undefined) {
    request.ifRevision = ifRevision
  }
  const toRevision = optionalRemoteCliNumber(parsed.flags, 'to-revision')
  if (toRevision !== undefined) {
    request.toRevision = toRevision
  }

  const response = await dispatchLedger(dispatcher, 'status.get')
  if (!response.ok) {
    return response
  }
  if (!(response.result as RuntimeStatus).capabilities?.includes('ledger.v1')) {
    return {
      ...response,
      ok: false,
      error: {
        code: 'incompatible_runtime',
        message: 'Selected runtime does not support ledger.v1'
      }
    }
  }
  return await dispatchLedger(dispatcher, 'ledger.request', { request }, envelope)
}

async function dispatchLedger(
  dispatcher: RpcDispatcher,
  method: string,
  params?: Record<string, unknown>,
  envelope?: RuntimeOrchestrationEnvelope
): Promise<RpcResponse> {
  return await dispatcher.dispatch({
    id: `remote-cli-${Date.now()}`,
    authToken: 'remote-cli',
    method,
    params,
    orchestrationCapability: envelope?.orchestrationCapability,
    orchestrationContractVersion: method.startsWith('orchestration.')
      ? ORCHESTRATION_CONTRACT_VERSION
      : undefined,
    orchestrationRequestId: envelope?.orchestrationRequestId,
    compatibilityInvocationId:
      envelope?.orchestrationRequestId ?? envelope?.compatibilityInvocationId,
    orchestrationCompatibilityEvidence: envelope?.orchestrationCompatibilityEvidence
  })
}
