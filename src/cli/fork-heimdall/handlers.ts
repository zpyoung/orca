import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { HEIMDALL_CHANNELS } from '../../shared/fork-heimdall/api'
import type { CommandHandler } from '../dispatch'
import { getRequiredStringFlag } from '../flags'
import { printResult } from '../format'

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
  }
}
