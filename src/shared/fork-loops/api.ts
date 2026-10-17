import type { LoopCreateInput, LoopEditPatch, LoopSnapshot, QueueOp } from './loop-types'

export const LOOPS_CHANNELS = {
  create: 'loops:create',
  list: 'loops:list',
  get: 'loops:get',
  pause: 'loops:pause',
  resume: 'loops:resume',
  stop: 'loops:stop',
  steer: 'loops:steer',
  edit: 'loops:edit',
  queue: 'loops:queue',
  bindTab: 'loops:bindTab',
  detach: 'loops:detach',
  openTab: 'loops:openTab'
} as const

export const LOOPS_CHANGED_CHANNEL = 'loops:changed' as const

export type LoopsApi = {
  create: (input: LoopCreateInput) => Promise<LoopSnapshot>
  list: (filter?: { worktreeId?: string }) => Promise<LoopSnapshot[]>
  get: (loopId: string) => Promise<LoopSnapshot>
  pause: (loopId: string, mode: 'after-iteration') => Promise<LoopSnapshot>
  resume: (loopId: string, opts?: { addIterations?: number }) => Promise<LoopSnapshot>
  stop: (loopId: string, mode: 'after-iteration' | 'now') => Promise<LoopSnapshot>
  steer: (loopId: string, text: string) => Promise<LoopSnapshot>
  edit: (loopId: string, patch: LoopEditPatch) => Promise<LoopSnapshot>
  queue: (loopId: string, op: QueueOp) => Promise<LoopSnapshot>
  bindTab: (loopId: string, tab: { tabId: string; paneKey: string }) => Promise<LoopSnapshot>
  detach: (loopId: string) => Promise<LoopSnapshot>
  openTab: (loopId: string) => Promise<LoopSnapshot>
  onChanged: (listener: (snapshot: LoopSnapshot) => void) => () => void
}
