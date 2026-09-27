import { unlinkSync } from 'node:fs'
import { cloneLedger } from '../../shared/ledger-entry-snapshots'
import { validateLedgerRequest } from '../../shared/ledger-request-validation'
import { ledgerEntriesNearMatch } from '../../shared/ledger-locations'
import { triageLedgerEntries } from '../../shared/ledger-triage'
import { createLedgerEntry, mutateLedgerEntry, applyLedgerBulk } from './ledger-entry-mutations'
import {
  loadLedgerRecords,
  ledgerRecordPath,
  persistLedgerRecord,
  syncLedgerDirectory
} from './ledger-store-persistence'
import { reconcileLedgerImports } from './ledger-store-import'
import { attachLedger } from './ledger-store-attachment'
import { reconcileLedgerOwners } from './ledger-store-owner-recovery'
import { ledgerEntryMatches } from './ledger-store-query'
import { createLedgerRecord, findDetachedLedger } from './ledger-store-records'
import { createLedgerResponse, summarizeLedger } from './ledger-store-response'
import {
  LedgerError,
  type LedgerRecord,
  type LedgerRequest,
  type LedgerResponse,
  type LedgerMutationContext,
  type LedgerOwner,
  type LedgerRuntimeIdentity,
  type LedgerSummary
} from '../../shared/ledger'

type Options = { directory: string; runtime: LedgerRuntimeIdentity; now?: () => Date }
export class LedgerStore {
  private readonly now: () => Date
  private readonly records: Map<string, LedgerRecord>
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private readonly options: Options) {
    this.now = options.now ?? (() => new Date())
    this.records = loadLedgerRecords(options.directory, options.runtime)
  }
  run<T>(action: () => T | Promise<T>): Promise<T> {
    const result = this.queue.then(action)
    this.queue = result.catch(() => undefined)
    return result
  }
  listLedgers(): LedgerSummary[] {
    return [...this.records.values()].map((record) => summarizeLedger(record, this.options.runtime))
  }
  getLedger(id: string): LedgerRecord | null {
    const r = this.records.get(id)
    return r ? cloneLedger(r) : null
  }
  findLedger(owner: LedgerOwner): LedgerRecord | null {
    const r = [...this.records.values()].find(
      (x) => x.owner?.tier === owner.tier && x.owner.id === owner.id
    )
    return r ? cloneLedger(r) : null
  }
  reconcileOwners(liveOwners: readonly LedgerOwner[]): void {
    reconcileLedgerOwners(this.records, liveOwners, {
      now: () => this.now().toISOString(),
      findLedger: (owner) => this.findLedger(owner),
      commit: (record) => this.commit(record)
    })
  }
  execute(request: LedgerRequest, context: LedgerMutationContext): Promise<LedgerResponse> {
    return this.run(() => this.executeQueued(request, context))
  }
  public executeQueued(request: LedgerRequest, context: LedgerMutationContext): LedgerResponse {
    validateLedgerRequest(request)
    const id = request.target?.ledgerId ?? context.ledgerId
    let record = id ? this.records.get(id) : context.owner ? this.findLedger(context.owner) : null
    if (request.operation === 'import' && !context.importRecords?.length) {
      return this.response(record ?? null, {
        importResult: {
          created: [],
          updated: [],
          alreadyPresent: [],
          skipped: cloneLedger(context.importSkipped ?? [])
        }
      })
    }
    if (
      record &&
      !request.target?.ledgerId &&
      context.ownerIsLive &&
      record.owner &&
      !context.ownerIsLive(record.owner)
    ) {
      throw new LedgerError('owner-missing', 'Ledger owner disappeared before commit')
    }
    if (request.operation === 'catalog') {
      return this.response(null, { ledgers: this.listLedgers() })
    }
    if (
      request.operation === 'list' ||
      request.operation === 'show' ||
      request.operation === 'review'
    ) {
      if (!record) {
        if (id || request.operation === 'show') {
          throw new LedgerError('not-found', 'Ledger not found')
        }
        if (!context.owner || (context.ownerIsLive && !context.ownerIsLive(context.owner))) {
          throw new LedgerError('owner-missing', 'Ledger owner is unavailable')
        }
        return this.response(
          null,
          request.operation === 'review' ? { candidates: [] } : { entries: [] }
        )
      }
      const threshold = record.staleAfterDays
      const entries = record.entries.filter((entry) =>
        ledgerEntryMatches(entry, request.filters, this.now(), threshold)
      )
      if (request.operation === 'review') {
        return this.response(record, {
          candidates: triageLedgerEntries(entries, this.now(), threshold)
        })
      }
      if (request.operation === 'show') {
        if (!request.id) {
          throw new LedgerError('invalid-request', 'show requires id')
        }
        const entry = entries.find((e) => e.id === request.id)
        if (!entry) {
          throw new LedgerError('not-found', 'Entry not found')
        }
        return this.response(record, { entry })
      }
      return this.response(record, { entries })
    }
    if (request.operation === 'file' || request.operation === 'import') {
      if (!record) {
        if (id) {
          throw new LedgerError('not-found', 'Ledger not found')
        }
        if (!context.owner) {
          throw new LedgerError('owner-required', 'Owner is required')
        }
        if (context.ownerIsLive && !context.ownerIsLive(context.owner)) {
          throw new LedgerError('owner-missing', 'Ledger owner is no longer live')
        }
        record =
          findDetachedLedger(this.records, context.owner, (owner) => this.findLedger(owner)) ??
          createLedgerRecord(context.owner, this.options.runtime)
        if (!record.owner) {
          record.owner = cloneLedger(context.owner)
          record.revision++
          record.metadataHistory.push({
            revision: record.revision,
            at: this.now().toISOString(),
            actor: context.actor,
            before: { owner: null },
            after: { owner: record.owner },
            changedFields: ['owner']
          })
        }
      } else {
        record = cloneLedger(record)
      }
      if (request.operation === 'file') {
        const entry = createLedgerEntry(
          record,
          request.type!,
          request.content!,
          context,
          this.now().toISOString()
        )
        this.commit(record)
        return this.response(record, {
          entry,
          matches: ledgerEntriesNearMatch(
            entry,
            record.entries.filter((x) => x.id !== entry.id),
            record.sourceEquivalences
          )
        })
      }
      return reconcileLedgerImports(record, context, {
        now: () => this.now().toISOString(),
        commit: (next) => this.commit(next),
        response: (next, extra) => this.response(next, extra),
        hasRecord: (ledgerId) => this.records.has(ledgerId)
      })
    }
    if (!record) {
      throw new LedgerError('not-found', 'Ledger not found')
    }
    record = cloneLedger(record)
    if (
      request.operation === 'edit' ||
      request.operation === 'state' ||
      request.operation === 'revert'
    ) {
      const result = mutateLedgerEntry(record, request, context, this.now().toISOString())
      if (result.changed) {
        this.commit(record)
      }
      return this.response(record, { entry: result.entry })
    }
    if (request.operation === 'bulk-state' || request.operation === 'approve') {
      const result = applyLedgerBulk(record, request, context, this.now().toISOString())
      if (result.changed) {
        this.commit(record)
      }
      return this.response(record, { entries: result.entries })
    }
    if (request.operation === 'delete-entries') {
      if (context.channel !== 'ui' || request.confirmed !== true) {
        throw new LedgerError('confirmation-required', 'Hard deletion requires UI confirmation')
      }
      const selections = request.selections ?? []
      for (const selection of selections) {
        const entry = record.entries.find((candidate) => candidate.id === selection.id)
        if (!entry || entry.revision !== selection.revision) {
          throw new LedgerError('conflict', 'Entry revision is stale', {
            id: selection.id,
            currentRevision: entry?.revision
          })
        }
      }
      if (!selections.length) {
        return this.response(record, {})
      }
      const ids = new Set(selections.map((selection) => selection.id))
      record.entries = record.entries.filter((entry) => !ids.has(entry.id))
      for (const anchor of Object.values(record.importAnchors)) {
        if (!anchor.entryId || !ids.has(anchor.entryId)) {
          continue
        }
        anchor.deleted = true
        delete anchor.baseline
      }
      record.revision++
      this.commit(record)
      return this.response(record, {})
    }
    if (request.operation === 'delete-ledger') {
      if (context.channel !== 'ui' || request.confirmed !== true) {
        throw new LedgerError('confirmation-required', 'Ledger deletion requires UI confirmation')
      }
      if (request.ifLedgerRevision === undefined || request.ifLedgerRevision !== record.revision) {
        throw new LedgerError('conflict', 'Ledger revision is stale')
      }
      try {
        unlinkSync(ledgerRecordPath(this.options.directory, record.ledgerId))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error
        }
      }
      syncLedgerDirectory(this.options.directory)
      this.records.delete(record.ledgerId)
      return this.response(null, {})
    }
    if (request.operation === 'settings') {
      if (context.channel !== 'ui') {
        throw new LedgerError('forbidden', 'Settings are UI-only')
      }
      if (request.ifLedgerRevision === undefined || request.ifLedgerRevision !== record.revision) {
        throw new LedgerError('conflict', 'Ledger revision is stale')
      }
      if (request.staleAfterDays !== undefined) {
        if (!Number.isSafeInteger(request.staleAfterDays) || request.staleAfterDays < 0) {
          throw new LedgerError('invalid-settings', 'Invalid stale threshold')
        }
        const before = record.staleAfterDays
        if (before !== request.staleAfterDays) {
          record.staleAfterDays = request.staleAfterDays
          record.revision++
          record.metadataHistory.push({
            revision: record.revision,
            at: this.now().toISOString(),
            actor: context.actor,
            before: { staleAfterDays: before },
            after: { staleAfterDays: request.staleAfterDays },
            changedFields: ['staleAfterDays']
          })
          this.commit(record)
        }
      }
      return this.response(record, {})
    }
    if (request.operation === 'attach') {
      return attachLedger(record, request, context, {
        now: () => this.now().toISOString(),
        findLedger: (owner) => this.findLedger(owner),
        commit: (next) => this.commit(next),
        response: (next, extra) => this.response(next, extra)
      })
    }
    throw new LedgerError('unsupported-operation', `Unsupported operation ${request.operation}`)
  }
  private response(r: LedgerRecord | null, extra: Partial<LedgerResponse>): LedgerResponse {
    return createLedgerResponse(r, this.options.runtime, extra)
  }
  private commit(r: LedgerRecord): void {
    const next = persistLedgerRecord(this.options.directory, r)
    this.records.set(next.ledgerId, next)
  }
}
export type { Options as LedgerStoreOptions }
