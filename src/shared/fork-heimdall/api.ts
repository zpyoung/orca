import { z } from 'zod'
import { ApprovalScopeSchema, type ApprovalScope } from './gate'
import { WatcherLedgerSchema, type WatcherLedger } from './ledger-types'
import {
  EnrollInputSchema,
  WatcherListEntrySchema,
  type EnrollInput,
  type WatcherListEntry
} from './watcher-types'

const WatcherIdSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0)

export const HEIMDALL_CHANNELS = {
  list: 'heimdall:list',
  enroll: 'heimdall:enroll',
  disarm: 'heimdall:disarm',
  disarmAll: 'heimdall:disarmAll',
  approve: 'heimdall:approve',
  ledger: 'heimdall:ledger',
  debugReport: 'heimdall:debugReport'
} as const

export const WatcherIdRequestSchema = z.object({ watcherId: WatcherIdSchema }).strict()
export type WatcherIdRequest = z.infer<typeof WatcherIdRequestSchema>

export const ApproveRequestSchema = z
  .object({
    watcherId: WatcherIdSchema,
    scope: ApprovalScopeSchema
  })
  .strict()
export type ApproveRequest = z.infer<typeof ApproveRequestSchema>

export const EmptyHeimdallRequestSchema = z.object({}).strict()

export const EnrollSuccessSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('enrolled'), entry: WatcherListEntrySchema }).strict(),
  z.object({ status: z.literal('re-armed'), entry: WatcherListEntrySchema }).strict()
])
export type EnrollSuccess = z.infer<typeof EnrollSuccessSchema>

export const WatcherListSchema = z.array(WatcherListEntrySchema)
export { EnrollInputSchema, WatcherLedgerSchema }
export type { ApprovalScope, EnrollInput, WatcherLedger, WatcherListEntry }

/** Refused enrollment rejects with a message ending in its typed reason. */
export type HeimdallApi = {
  list(): Promise<WatcherListEntry[]>
  enroll(input: EnrollInput): Promise<EnrollSuccess>
  disarm(watcherId: string): Promise<void>
  disarmAll(): Promise<void>
  approve(watcherId: string, scope: ApprovalScope): Promise<void>
  ledger(watcherId: string): Promise<WatcherLedger>
  debugReport(watcherId: string): Promise<unknown>
}
