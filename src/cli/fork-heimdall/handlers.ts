import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  HEIMDALL_CHANNELS,
  type HeimdallFleetSnapshot,
  type WatcherCommandResult
} from '../../shared/fork-heimdall/api'
import { HEIMDALL_PARALLEL_EXECUTION_RUNTIME_CAPABILITY } from '../../shared/fork-heimdall/capability'
import type { RuntimeStatus } from '../../shared/runtime-types'
import type { CommandHandler } from '../dispatch'
import { getRequiredStringFlag } from '../flags'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime/types'

export const HEIMDALL_HANDLERS: Record<string, CommandHandler> = {
  'heimdall debug': async ({ flags, client, cwd }) => {
    const watcherId = getRequiredStringFlag(flags, 'watcher-id')
    const outPath = flags.has('out') ? getRequiredStringFlag(flags, 'out') : undefined
    const response = await client.call<unknown>(HEIMDALL_CHANNELS.debugReport, {
      watcherId,
      connectionId: null,
      pairingRevision: null
    })
    const reportJson = JSON.stringify(response.result, null, 2) ?? 'null'

    if (outPath !== undefined) {
      await writeFile(resolve(cwd, outPath), `${reportJson}\n`, 'utf8')
      return
    }
    // Why: unlike normal CLI JSON output, the debug report is the entire contract;
    // never wrap it in the runtime response envelope, even without --json.
    printResult(response, false, () => reportJson)
  },
  'heimdall set-concurrency': async ({ flags, client, json }) => {
    const watcherId = getRequiredStringFlag(flags, 'watcher-id')
    const rawMaxConcurrency = getRequiredStringFlag(flags, 'max-concurrency')
    if (!/^[1-9]\d*$/u.test(rawMaxConcurrency)) {
      throw new RuntimeClientError(
        'invalid_argument',
        '--max-concurrency must be a whole number from 1 to 1024'
      )
    }
    const maxConcurrency = Number(rawMaxConcurrency)
    if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency > 1_024) {
      throw new RuntimeClientError(
        'invalid_argument',
        '--max-concurrency must be a whole number from 1 to 1024'
      )
    }
    const status = await client.call<RuntimeStatus>('status.get')
    if (!status.result.capabilities?.includes(HEIMDALL_PARALLEL_EXECUTION_RUNTIME_CAPABILITY)) {
      throw new RuntimeClientError(
        'incompatible_runtime',
        'The running Orca runtime does not support live objective concurrency changes. Update or restart Orca and try again.'
      )
    }
    const fleet = await client.call<HeimdallFleetSnapshot>(HEIMDALL_CHANNELS.fleet, {})
    const row = fleet.result.entries.find((entry) => entry.target.watcherId === watcherId)
    if (!row) {
      throw new RuntimeClientError(
        'invalid_argument',
        `Heimdall watcher ${watcherId} was not found`
      )
    }
    const kindPayload = row.entry.enrollment.kindPayload
    const effectiveMaxConcurrency =
      row.entry.enrollment.kind === 'objective' &&
      typeof kindPayload === 'object' &&
      kindPayload !== null &&
      'workspaceKind' in kindPayload &&
      kindPayload.workspaceKind === 'folder'
        ? 1
        : maxConcurrency
    const response = await client.call<WatcherCommandResult>(HEIMDALL_CHANNELS.command, {
      target: row.target,
      expectedOwner: row.ownerFence,
      command: { kind: 'set-concurrency', maxConcurrency: effectiveMaxConcurrency }
    })
    printResult(response, json, (result) =>
      result.status === 'applied'
        ? `Set Heimdall watcher ${watcherId} concurrency to ${effectiveMaxConcurrency}.`
        : result.status === 'refused'
          ? `Concurrency change refused (${result.reason}): ${result.detail}`
          : `Concurrency change is indeterminate: ${result.detail}`
    )
  }
}
