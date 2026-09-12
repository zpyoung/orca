import { dirname, join } from 'node:path'
import { LedgerStore } from './ledger-store'
import {
  collectLedgerReviewEvidence,
  type LedgerHostIo,
  type LedgerHostWorkspace
} from './ledger-host-context'
import { prepareLedgerHostRequest } from './ledger-host-preparation'
import { liveLedgerOwners, resolveLedgerOwner, type LedgerCatalog } from './ledger-owner-resolution'
import { assertRemovalPreviewMatches, ledgerRemovalPreview } from './ledger-removal-preview'
import {
  LedgerError,
  type LedgerActor,
  type LedgerMutationContext,
  type LedgerRequest,
  type LedgerResponse,
  type LedgerRuntimeIdentity,
  type LedgerReviewCandidate,
  type LedgerLocation
} from '../../shared/ledger'
import type { OrchestrationCompatibilityEvidence } from '../../shared/orchestration-compatibility-evidence'

type Options = {
  directory: string
  runtime: LedgerRuntimeIdentity
  catalog: () => LedgerCatalog | Promise<LedgerCatalog>
  verify?: (evidence: OrchestrationCompatibilityEvidence | undefined) => LedgerActor | null
  resolveHost?: (
    workspaceId: string
  ) => Promise<{ workspace: LedgerHostWorkspace; io: LedgerHostIo } | null>
  normalizeUiLocation?: (location: LedgerLocation) => Promise<LedgerLocation>
  now?: () => Date
}

/** Main-process owner and trust boundary for every ledger surface. */
export class LedgerRuntimeService {
  private readonly store: LedgerStore | null
  private readonly initializationError: LedgerError | null
  private catalogError: LedgerError | null = null
  private readonly options: Options

  constructor(options: Options) {
    this.options = options
    try {
      this.store = new LedgerStore({
        directory: options.directory,
        runtime: options.runtime,
        now: options.now
      })
      this.initializationError = null
    } catch (error) {
      this.store = null
      this.initializationError =
        error instanceof LedgerError
          ? error
          : new LedgerError('incompatible-store', 'Ledger store is unavailable', {
              cause: String(error)
            })
    }
  }

  private requireStore(options: { allowCatalogError?: boolean } = {}): LedgerStore {
    if (this.initializationError) {
      throw this.initializationError
    }
    if (this.catalogError && !options.allowCatalogError) {
      throw this.catalogError
    }
    if (!this.store) {
      throw new LedgerError('incompatible-store', 'Ledger store is unavailable')
    }
    return this.store
  }

  async executeLedgerRequest(
    request: LedgerRequest,
    evidence?: OrchestrationCompatibilityEvidence
  ): Promise<LedgerResponse> {
    return this.execute(request, 'cli', this.actorForCli(evidence))
  }

  async executeLedgerUiRequest(request: LedgerRequest): Promise<LedgerResponse> {
    return this.execute(request, 'ui', { kind: 'human', model: null, providerSessionId: null })
  }

  private async execute(
    request: LedgerRequest,
    channel: 'cli' | 'ui',
    actor: LedgerActor
  ): Promise<LedgerResponse> {
    const store = this.requireStore()
    const response = await store.run(async () => {
      const catalog = await this.options.catalog()
      const prepared = await this.prepareHost(request)
      this.validateRequestShape(request, channel)
      const owner = resolveLedgerOwner(request, catalog, channel)
      this.assertLedgerTargetExists(request)
      if (request.operation === 'removal-preview') {
        return ledgerRemovalPreview(request, catalog, store, this.options.runtime)
      }
      const context: LedgerMutationContext = {
        channel,
        actor,
        owner,
        ledgerId: request.target?.ledgerId,
        ...(prepared?.importRecords ? { importRecords: prepared.importRecords } : {}),
        ...(prepared?.importSkips ? { importSkipped: prepared.importSkips } : {}),
        ...(prepared?.origin ? { origin: prepared.origin } : {}),
        ownerIsLive: (candidate) =>
          liveLedgerOwners(catalog).some(
            (live) => live.tier === candidate.tier && live.id === candidate.id
          )
      }
      if (this.mutatesCatalog(request)) {
        store.reconcileOwners(liveLedgerOwners(catalog))
      }
      return store.executeQueued(
        prepared?.content ? { ...request, content: prepared.content } : request,
        context
      )
    })
    return this.decorateReview(response)
  }

  private async prepareHost(request: LedgerRequest) {
    return prepareLedgerHostRequest(request, {
      resolveHost: this.options.resolveHost,
      normalizeUiLocation: this.options.normalizeUiLocation,
      detachedEntryContent: (ledgerId, entryId) =>
        this.requireStore()
          .getLedger(ledgerId)
          ?.entries.find((entry) => entry.id === entryId)?.content
    })
  }

  private async decorateReview(response: LedgerResponse): Promise<LedgerResponse> {
    if (!response.candidates || !this.options.resolveHost) {
      return response
    }
    const candidates = await Promise.all(
      response.candidates.map(async (candidate: LedgerReviewCandidate) => ({
        ...candidate,
        evidence: await collectLedgerReviewEvidence(candidate.entry, this.options.resolveHost!)
      }))
    )
    return { ...response, candidates }
  }

  async reconcileCatalog(): Promise<void> {
    const store = this.requireStore({ allowCatalogError: true })
    try {
      await store.run(async () =>
        store.reconcileOwners(liveLedgerOwners(await this.options.catalog()))
      )
      this.catalogError = null
    } catch (error) {
      this.catalogError =
        error instanceof LedgerError
          ? error
          : new LedgerError('catalog-unavailable', 'Ledger catalog reconciliation failed', {
              cause: String(error)
            })
      throw this.catalogError
    }
  }

  async validateRemovalExpectedLedgers(request: LedgerRequest): Promise<void> {
    const store = this.requireStore()
    await store.run(async () => {
      const actual =
        ledgerRemovalPreview(request, await this.options.catalog(), store, this.options.runtime)
          .removalPreview ?? []
      assertRemovalPreviewMatches(actual, request.removal?.expectedLedgers ?? [], 'actual')
    })
  }

  async getRemovalPreview(removal: {
    repoId?: string
    projectGroupId?: string
  }): Promise<NonNullable<LedgerResponse['removalPreview']>> {
    const store = this.requireStore()
    return store.run(
      async () =>
        ledgerRemovalPreview(
          { operation: 'removal-preview', removal },
          await this.options.catalog(),
          store,
          this.options.runtime
        ).removalPreview ?? []
    )
  }

  async withCatalogRemoval<T>(
    removal: { repoId?: string; projectGroupId?: string; removeContainedProjects?: boolean },
    expectedLedgers: { ledgerId: string; revision: number }[] | undefined,
    mutate: () => T
  ): Promise<{ result: T; ledgers: NonNullable<LedgerResponse['removalPreview']> }> {
    const store = this.requireStore()
    return store.run(async () => {
      const before = await this.options.catalog()
      const expected =
        ledgerRemovalPreview(
          { operation: 'removal-preview', removal },
          before,
          store,
          this.options.runtime
        ).removalPreview ?? []
      if (expectedLedgers) {
        assertRemovalPreviewMatches(expected, expectedLedgers, 'currentPreview')
      }
      const result = mutate()
      store.reconcileOwners(liveLedgerOwners(await this.options.catalog()))
      return { result, ledgers: expected }
    })
  }

  private mutatesCatalog(request: LedgerRequest): boolean {
    return !['list', 'show', 'review', 'catalog'].includes(request.operation)
  }

  private validateRequestShape(request: LedgerRequest, channel: 'cli' | 'ui'): void {
    const target = request.target
    if (target?.group && target.groupSelector) {
      throw new LedgerError('invalid-target', 'group and groupSelector are mutually exclusive')
    }
    if (
      target?.ledgerId &&
      (target.workspaceId || target.owner || target.group || target.groupSelector)
    ) {
      throw new LedgerError('invalid-target', 'ledgerId cannot be combined with an owner selector')
    }
    if (channel === 'cli') {
      if (target?.owner) {
        throw new LedgerError('forbidden', 'CLI owner selectors are not permitted')
      }
      if (target?.ledgerId && !['list', 'show', 'review'].includes(request.operation)) {
        throw new LedgerError('forbidden', 'CLI detached-ledger mutations are not permitted')
      }
      if (
        [
          'approve',
          'bulk-state',
          'delete-entries',
          'delete-ledger',
          'attach',
          'settings',
          'removal-preview'
        ].includes(request.operation) &&
        !target?.workspaceId
      ) {
        throw new LedgerError(
          'forbidden',
          'Operation requires the trusted UI path or a workspace target'
        )
      }
    }
    if (target?.groupSelector && !target.workspaceId) {
      throw new LedgerError('invalid-target', 'groupSelector requires a workspace')
    }
  }

  private assertLedgerTargetExists(request: LedgerRequest): void {
    const id = request.target?.ledgerId
    if (id && !this.requireStore().getLedger(id)) {
      throw new LedgerError('not-found', 'Ledger not found', { ledgerId: id })
    }
  }

  private actorForCli(evidence?: OrchestrationCompatibilityEvidence): LedgerActor {
    const authority = this.options.verify?.(evidence)
    return authority?.kind === 'agent'
      ? authority
      : { kind: 'unknown', model: null, providerSessionId: null }
  }
}

export function ledgerDirectoryForStore(dataFile: string, profileId: string): string {
  void profileId
  return join(dirname(dataFile), 'ledgers')
}
