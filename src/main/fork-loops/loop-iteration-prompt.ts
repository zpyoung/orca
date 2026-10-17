import { composeIterationPrompt } from '../../shared/fork-loops/loop-prompt'
import type { IterationRecord } from '../../shared/fork-loops/loop-types'
import type { QueueItem, StoredLoop } from './loop-database'
import type { IterationContext } from './loop-driver-types'
import { loopNotesPath } from './loop-notes-file'

/** The prompt for one iteration: the queue item or repeated body plus the carried-over evidence. */
export function composeLoopPrompt(args: {
  loop: StoredLoop
  ctx: IterationContext
  item: QueueItem | null
  notes: string[]
  history: IterationRecord[]
  includePreamble: boolean
}): string {
  const { loop, ctx, item, notes, history } = args
  const { config } = loop
  const body = item?.body ?? (config.promptSource.kind === 'repeat' ? config.promptSource.body : '')
  return composeIterationPrompt({
    loop: config,
    iteration: ctx.n,
    maxIterations: config.caps.maxIterations ?? null,
    previousCheck: history.at(-1)?.check ?? null,
    steerNotes: notes,
    body,
    notesPath: ctx.targets
      ? loopNotesPath(ctx.targets.workspace, loop.slug)
      : `.orca/loops/${loop.slug}/notes.md`,
    includePreamble: args.includePreamble
  })
}
