import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ObjectiveDetail } from '../../shared/fork-heimdall-objective/detail-types'
import { HEIMDALL_CHANNELS } from '../../shared/fork-heimdall/api'
import type { HeimdallFleetSnapshot, WatcherDetail } from '../../shared/fork-heimdall/fleet-types'
import type { CommandHandler } from '../dispatch'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime/types'
import {
  formatHeimdallFleet,
  formatObjectiveDetail,
  formatWatcherDetail
} from './watcher-text-format'
import {
  resolveWatcherRow,
  resolveWatcherWorktreeFilter,
  watcherMatchesWorktree
} from './watcher-row'

export const HEIMDALL_READ_HANDLERS: Record<string, CommandHandler> = {
  'heimdall list': async ({ flags, client, cwd, json }) => {
    const kind = flags.has('kind') ? getRequiredStringFlag(flags, 'kind') : undefined
    if (kind !== undefined && kind !== 'objective' && kind !== 'hosted-review') {
      throw new RuntimeClientError('invalid_argument', '--kind must be objective or hosted-review')
    }
    const worktree = await resolveWatcherWorktreeFilter(flags, cwd, client)
    const response = await client.call<HeimdallFleetSnapshot>(HEIMDALL_CHANNELS.fleet, {})
    if (kind === undefined && worktree === undefined) {
      printResult(response, json, formatHeimdallFleet)
      return
    }
    const entries: HeimdallFleetSnapshot['entries'] = []
    for (const row of response.result.entries) {
      if (kind !== undefined && row.entry.enrollment.kind !== kind) {
        continue
      }
      if (worktree !== undefined && !watcherMatchesWorktree(row, worktree)) {
        continue
      }
      entries.push(row)
    }
    printResult({ ...response, result: { ...response.result, entries } }, json, formatHeimdallFleet)
  },
  'heimdall show': async ({ flags, client, json }) => {
    const watcherId = getRequiredStringFlag(flags, 'watcher-id')
    const row = await resolveWatcherRow(client, watcherId)
    const response = await client.call<WatcherDetail>(HEIMDALL_CHANNELS.detail, row.target)
    printResult(response, json, formatWatcherDetail)
  },
  'heimdall objective': async ({ flags, client, json }) => {
    const watcherId = getRequiredStringFlag(flags, 'watcher-id')
    const row = await resolveWatcherRow(client, watcherId)
    if (row.entry.enrollment.kind !== 'objective') {
      throw new RuntimeClientError(
        'invalid_argument',
        `Heimdall watcher ${watcherId} is not an objective watcher`
      )
    }
    const response = await client.call<ObjectiveDetail>(
      HEIMDALL_CHANNELS.objectiveDetail,
      row.target
    )
    printResult(response, json, formatObjectiveDetail)
  },
  'heimdall debug': async ({ flags, client, cwd }) => {
    const watcherId = getRequiredStringFlag(flags, 'watcher-id')
    const outPath = getOptionalStringFlag(flags, 'out')
    const row = await resolveWatcherRow(client, watcherId)
    const response = await client.call<unknown>(HEIMDALL_CHANNELS.debugReport, row.target)
    const reportJson = JSON.stringify(response.result, null, 2) ?? 'null'

    if (outPath !== undefined) {
      await writeFile(resolve(cwd, outPath), `${reportJson}\n`, 'utf8')
      return
    }
    // Why: debug's report itself is the user-facing contract, not an RPC result envelope.
    printResult(response, false, () => reportJson)
  }
}
