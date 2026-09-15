import { z } from 'zod'
import {
  HeimdallFleetSnapshotSchema,
  WatcherCommandRequestSchema,
  WatcherCommandResultSchema,
  WatcherDetailSchema,
  WatcherTargetSchema,
  type HeimdallFleetSnapshot,
  type WatcherCommandRequest,
  type WatcherCommandResult,
  type WatcherDetail,
  type WatcherTarget
} from './fleet-types'
import { EnrollInputSchema, WatcherListEntrySchema, type EnrollInput } from './watcher-types'
import type { ObjectiveDetail } from '../fork-heimdall-objective/detail-types'

export const HEIMDALL_CHANNELS = {
  enroll: 'heimdall:enroll',
  fleet: 'heimdall:fleet',
  detail: 'heimdall:detail',
  objectiveDetail: 'heimdall:objectiveDetail',
  command: 'heimdall:command',
  debugReport: 'heimdall:debugReport',
  subscribe: 'heimdall:subscribe',
  unsubscribe: 'heimdall:unsubscribe'
} as const

export const HeimdallRemoteOwnerSchema = z
  .object({
    connectionId: WatcherTargetSchema.shape.connectionId.unwrap(),
    pairingRevision: WatcherTargetSchema.shape.pairingRevision.unwrap()
  })
  .strict()
export type HeimdallRemoteOwner = z.infer<typeof HeimdallRemoteOwnerSchema>

export const HeimdallEnrollRequestSchema = z
  .object({
    input: EnrollInputSchema,
    owner: HeimdallRemoteOwnerSchema.nullable()
  })
  .strict()

export const EmptyHeimdallRequestSchema = z.object({}).strict()
export const HeimdallUnsubscribeRequestSchema = z
  .object({ subscriptionId: z.string().min(1) })
  .strict()

export const HeimdallSubscriptionEventSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('ready'),
      subscriptionId: z.string().min(1),
      snapshot: HeimdallFleetSnapshotSchema
    })
    .strict(),
  z.object({ type: z.literal('snapshot'), snapshot: HeimdallFleetSnapshotSchema }).strict(),
  z.object({ type: z.literal('end') }).strict()
])
export type HeimdallSubscriptionEvent = z.infer<typeof HeimdallSubscriptionEventSchema>

export const EnrollSuccessSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('enrolled'), entry: WatcherListEntrySchema }).strict(),
  z.object({ status: z.literal('re-armed'), entry: WatcherListEntrySchema }).strict()
])
export type EnrollSuccess = z.infer<typeof EnrollSuccessSchema>

export {
  EnrollInputSchema,
  HeimdallFleetSnapshotSchema,
  WatcherCommandRequestSchema,
  WatcherCommandResultSchema,
  WatcherDetailSchema,
  WatcherTargetSchema
}
export type {
  EnrollInput,
  HeimdallFleetSnapshot,
  WatcherCommandRequest,
  WatcherCommandResult,
  WatcherDetail,
  WatcherTarget
}

/** Refused enrollment rejects with a message ending in its typed reason. */
export type HeimdallApi = {
  enroll(input: EnrollInput, owner?: HeimdallRemoteOwner): Promise<EnrollSuccess>
  fleet(): Promise<HeimdallFleetSnapshot>
  detail(target: WatcherTarget): Promise<WatcherDetail>
  objectiveDetail?(target: WatcherTarget): Promise<ObjectiveDetail>
  command(request: WatcherCommandRequest): Promise<WatcherCommandResult>
  debugReport(target: WatcherTarget): Promise<unknown>
  onFleetChanged(listener: (snapshot: HeimdallFleetSnapshot) => void): () => void
}
