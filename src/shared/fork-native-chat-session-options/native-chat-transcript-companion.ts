// Values a transcript read recovers alongside the messages: a provider-authored
// turn boundary, and the model/effort the agent recorded for itself. Both are
// newest-wins over the window that was read, and both ride the same frames.
//
// Inside main the two travel together so the readers thread one decode/collect
// pair instead of one per value. On the wire they are separate top-level keys —
// see nativeChatCompanionFrameFields.

import type {
  NativeChatSessionOptionObservation,
  NativeChatTurnLifecycle
} from '../native-chat-types'

export type NativeChatTranscriptCompanion = {
  lifecycle?: NativeChatTurnLifecycle
  sessionOptions?: NativeChatSessionOptionObservation
}

/** The same two values seen as the sibling keys a wire frame carries. One shape
 *  for every hop, so the four frame types cannot drift apart. */
export type NativeChatCompanionFrameFields = NativeChatTranscriptCompanion

/**
 * Fold a newly decoded companion into the running one, field by field.
 *
 * Why per field: one record carries a lifecycle and no options, the next the
 * reverse. Replacing the whole object would drop whichever value the newest
 * record happened not to mention.
 *
 * Pure. Returns undefined only when the result carries no field at all, so
 * "nothing observed" and "an empty companion" never diverge downstream.
 */
export function mergeNativeChatTranscriptCompanion(
  base: NativeChatTranscriptCompanion | undefined,
  next: NativeChatTranscriptCompanion | null | undefined
): NativeChatTranscriptCompanion | undefined {
  const lifecycle = next?.lifecycle ?? base?.lifecycle
  const sessionOptions = next?.sessionOptions ?? base?.sessionOptions
  if (!lifecycle && !sessionOptions) {
    return undefined
  }
  return {
    ...(lifecycle ? { lifecycle } : {}),
    ...(sessionOptions ? { sessionOptions } : {})
  }
}

/**
 * Keep the older value when the newer record does not mention that field, i.e.
 * the mirror of `mergeNativeChatTranscriptCompanion` for a backwards (newest
 * first) scan, where the first value seen for a field is the one to keep.
 */
export function retainNativeChatTranscriptCompanion(
  base: NativeChatTranscriptCompanion | undefined,
  older: NativeChatTranscriptCompanion | null | undefined
): NativeChatTranscriptCompanion | undefined {
  return mergeNativeChatTranscriptCompanion(older ?? undefined, base)
}

/**
 * The companion's two fields as the sibling top-level keys a frame carries.
 *
 * `lifecycle` keeps the exact wire position it has always had: clients and hosts
 * update independently, and an older client reads `frame.lifecycle` directly, so
 * nesting it would strand turn-completion recovery with no codec change to blame
 * (docs/reference/remote-wire-compatibility.md, rule 3).
 *
 * An absent field is omitted rather than sent as undefined — JSON drops it either
 * way, and no reader may distinguish the two.
 */
export function nativeChatCompanionFrameFields(
  companion: NativeChatTranscriptCompanion | undefined
): NativeChatCompanionFrameFields {
  return {
    ...(companion?.lifecycle ? { lifecycle: companion.lifecycle } : {}),
    ...(companion?.sessionOptions ? { sessionOptions: companion.sessionOptions } : {})
  }
}

/** Rebuild the companion from the two frame keys, or undefined when neither is set. */
export function nativeChatCompanionFromFrame(
  frame: NativeChatCompanionFrameFields
): NativeChatTranscriptCompanion | undefined {
  return mergeNativeChatTranscriptCompanion(undefined, {
    ...(frame.lifecycle ? { lifecycle: frame.lifecycle } : {}),
    ...(frame.sessionOptions ? { sessionOptions: frame.sessionOptions } : {})
  })
}
