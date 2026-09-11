import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  FORK_SESSION_HANDOFF_LINEAGE_CAP,
  FORK_SESSION_HANDOFF_LINEAGE_VERSION,
  type ForkSessionHandoffLineageFile,
  type ForkSessionHandoffLineageRecord
} from '../../shared/fork-session-handoff/session-lineage-types'
import {
  parseForkSessionHandoffLineageFile,
  parseForkSessionHandoffLineageRecord,
  type ForkSessionHandoffLineageEnrichment
} from './session-lineage-validation'

export { FORK_SESSION_HANDOFF_LINEAGE_CAP }
const LINEAGE_DIRECTORY_NAME = 'fork-session-handoff'
const LINEAGE_FILE_NAME = 'session-lineage.json'

function cloneRecord(record: ForkSessionHandoffLineageRecord): ForkSessionHandoffLineageRecord {
  return {
    ...record,
    parent: { ...record.parent },
    child: { ...record.child }
  }
}

function pruneRecords(
  records: readonly ForkSessionHandoffLineageRecord[]
): ForkSessionHandoffLineageRecord[] {
  const recordsById = new Map<string, ForkSessionHandoffLineageRecord>()
  for (const record of records) {
    const previous = recordsById.get(record.id)
    if (!previous || previous.createdAt <= record.createdAt) {
      recordsById.set(record.id, record)
    }
  }
  return [...recordsById.values()]
    .sort((left, right) => left.createdAt - right.createdAt)
    .slice(-FORK_SESSION_HANDOFF_LINEAGE_CAP)
}

/** Resolve the fork-owned lineage file below Electron's userData directory. */
export function getForkSessionHandoffLineageFilePath(userDataPath: string): string {
  return path.join(userDataPath, LINEAGE_DIRECTORY_NAME, LINEAGE_FILE_NAME)
}

/** Persist and query the bounded session handoff lineage collection. */
export class ForkSessionHandoffLineageStore {
  private readonly filePath: string
  private records: ForkSessionHandoffLineageRecord[] | null = null
  private operationTail: Promise<void> = Promise.resolve()

  constructor(userDataPath: string) {
    this.filePath = getForkSessionHandoffLineageFilePath(userDataPath)
  }

  /** List lineage records after loading, validating, and pruning the on-disk file. */
  list(): Promise<ForkSessionHandoffLineageRecord[]> {
    return this.enqueue(async () => {
      await this.ensureLoaded()
      return this.records!.map(cloneRecord)
    })
  }

  /** Add one lineage record and atomically persist the bounded collection. */
  record(value: ForkSessionHandoffLineageRecord): Promise<void> {
    return this.enqueue(async () => {
      const record = parseForkSessionHandoffLineageRecord(value)
      if (!record) {
        throw new Error('Invalid session handoff lineage record.')
      }
      await this.ensureLoaded()
      if (this.records!.some(({ id }) => id === record.id)) {
        return
      }
      const nextRecords = pruneRecords([...this.records!, record])
      await this.writeRecords(nextRecords)
      this.records = nextRecords
    })
  }

  /** Fill missing child identity fields without replacing identity already observed. */
  enrich(enrichment: ForkSessionHandoffLineageEnrichment): Promise<void> {
    return this.enqueue(async () => {
      await this.ensureLoaded()
      const index = this.records!.findIndex(({ id }) => id === enrichment.recordId)
      if (index === -1) {
        return
      }
      const current = this.records![index]
      const paneKey = current.child.paneKey ?? enrichment.paneKey ?? null
      const providerSessionId =
        current.child.providerSessionId ?? enrichment.providerSessionId ?? null
      if (
        paneKey === current.child.paneKey &&
        providerSessionId === current.child.providerSessionId
      ) {
        return
      }
      const nextRecords = this.records!.slice()
      nextRecords[index] = {
        ...current,
        child: { ...current.child, paneKey, providerSessionId }
      }
      await this.writeRecords(nextRecords)
      this.records = nextRecords
    })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation)
    this.operationTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async ensureLoaded(): Promise<void> {
    if (this.records) {
      return
    }
    let parsedRecords: ForkSessionHandoffLineageRecord[] | null = null
    let unreadableFile = false
    try {
      const rawFile = await readFile(this.filePath, 'utf8')
      unreadableFile = true
      parsedRecords = parseForkSessionHandoffLineageFile(JSON.parse(rawFile))
    } catch (error) {
      unreadableFile = (error as NodeJS.ErrnoException)?.code !== 'ENOENT'
      parsedRecords = null
    }
    if (!parsedRecords) {
      // Why: starting empty makes the next write replace the file wholesale, so a file we
      // could not interpret — a forward version, a truncated write — is moved aside first.
      if (unreadableFile) {
        await rename(this.filePath, `${this.filePath}.unreadable`).catch(() => undefined)
      }
      this.records = []
      return
    }
    const prunedRecords = pruneRecords(parsedRecords)
    this.records = prunedRecords
    if (prunedRecords.length !== parsedRecords.length) {
      try {
        await this.writeRecords(prunedRecords)
      } catch {
        // a valid in-memory view is still usable when best-effort compaction fails
      }
    }
  }

  private async writeRecords(records: readonly ForkSessionHandoffLineageRecord[]): Promise<void> {
    const lineageFile: ForkSessionHandoffLineageFile = {
      version: FORK_SESSION_HANDOFF_LINEAGE_VERSION,
      records: records.map(cloneRecord)
    }
    const directoryPath = path.dirname(this.filePath)
    const temporaryPath = `${this.filePath}.tmp`
    await mkdir(directoryPath, { recursive: true })
    const serializedFile = JSON.stringify(lineageFile, null, 2)
    await writeFile(temporaryPath, `${serializedFile}\n`, 'utf8')
    await rename(temporaryPath, this.filePath)
  }
}
