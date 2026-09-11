import type { CommandHandler, HandlerContext } from '../dispatch'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import {
  content,
  entryId,
  enumFlag,
  filters,
  LEDGER_STATES,
  LEDGER_TYPES,
  revision,
  target,
  validateRequiredContent
} from './ledger-arguments'
import { formatLedgerResponse } from './ledger-format'
import { request } from './ledger-request'

function printLedgerResult(ctx: HandlerContext, value: Awaited<ReturnType<typeof request>>): void {
  printResult(
    { id: 'ledger', ok: true, result: value, _meta: { runtimeId: value.runtime.runtimeId } },
    ctx.json,
    formatLedgerResponse
  )
}

export const LEDGER_HANDLERS: Record<string, CommandHandler> = {
  'ledger file': async (ctx) => {
    const type = enumFlag(ctx, 'type', LEDGER_TYPES)
    if (!type) {
      throw new RuntimeClientError('invalid_argument', 'Missing required --type')
    }
    const fields = content(ctx)
    validateRequiredContent(type, fields)
    printLedgerResult(
      ctx,
      await request(ctx, {
        operation: 'file',
        type,
        content: fields,
        target: await target(ctx, false)
      })
    )
  },
  'ledger list': async (ctx) => {
    printLedgerResult(
      ctx,
      await request(ctx, {
        operation: 'list',
        target: await target(ctx, true),
        filters: filters(ctx)
      })
    )
  },
  'ledger show': async (ctx) => {
    printLedgerResult(
      ctx,
      await request(ctx, {
        operation: 'show',
        id: entryId(ctx),
        target: await target(ctx, true)
      })
    )
  },
  'ledger edit': async (ctx) => {
    const fields = content(ctx)
    if (Object.keys(fields).length === 0) {
      throw new RuntimeClientError('invalid_argument', 'Edit requires at least one content field')
    }
    printLedgerResult(
      ctx,
      await request(ctx, {
        operation: 'edit',
        id: entryId(ctx),
        ifRevision: revision(ctx, 'if-revision'),
        content: fields,
        target: await target(ctx, false)
      })
    )
  },
  'ledger state': async (ctx) => {
    const state = enumFlag(ctx, 'state', LEDGER_STATES)
    if (!state) {
      throw new RuntimeClientError('invalid_argument', 'Missing required --state')
    }
    printLedgerResult(
      ctx,
      await request(ctx, {
        operation: 'state',
        id: entryId(ctx),
        ifRevision: revision(ctx, 'if-revision'),
        state,
        target: await target(ctx, false)
      })
    )
  },
  'ledger review': async (ctx) => {
    printLedgerResult(
      ctx,
      await request(ctx, {
        operation: 'review',
        target: await target(ctx, true),
        filters: filters(ctx)
      })
    )
  },
  'ledger revert': async (ctx) => {
    printLedgerResult(
      ctx,
      await request(ctx, {
        operation: 'revert',
        id: entryId(ctx),
        ifRevision: revision(ctx, 'if-revision'),
        toRevision: revision(ctx, 'to-revision'),
        target: await target(ctx, false)
      })
    )
  },
  'ledger import': async (ctx) => {
    const value = await request(ctx, { operation: 'import', target: await target(ctx, false) })
    printLedgerResult(ctx, value)
    if (value.importResult?.skipped.length) {
      process.exitCode = 1
    }
  }
}
