import { memo, useRef } from 'react'
import type { NativeChatRewindSurface } from './use-native-chat-rewind'
import type { CommentMarkdownLinkClickHandler } from '@/components/sidebar/CommentMarkdown'
import { NativeChatUserMessageRow } from './NativeChatUserMessageRow'
import { NativeChatAssistantMessageRow } from './NativeChatAssistantMessageRow'
import type {
  NativeChatMessage,
  NativeChatToolCallBlock
} from '../../../../shared/native-chat-types'
import { deriveNativeChatRowContent } from '../../../../shared/native-chat-row-content'
import { NativeChatReasoningRow } from './NativeChatReasoningRow'
import { NativeChatNoticeRow } from './NativeChatNoticeRow'
import { nativeChatBlocksInOwnWords } from './native-chat-stopped-before-start-row'
import { ProviderFrameRow } from './NativeChatTranscriptChrome'
import type { NativeChatDiffReveal } from './native-chat-turn-diffs'
import type {
  NativeChatSubagentDisclosure,
  NativeChatSubagentRosterState
} from './native-chat-subagent-sections'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client'
import {
  nativeChatReasoningClassName,
  nativeChatUserMessageClassName
} from './fork-native-chat-coloring/native-chat-message-coloring'

/** What a user message says about its delivery: that nothing has confirmed it yet, quietly in
 *  place of its time, or that it did not go through, with its own Retry when the surface can send
 *  it again. */
export type NativeChatDeliveryNotice =
  | { sending: true; text?: never; onDismiss?: never }
  | { sending?: never; text: string; onDismiss?: () => void }

export type MessageRowProps = {
  message: NativeChatMessage
  agentName?: string
  previousTodoWrite?: NativeChatToolCallBlock
  previousUpdatePlan?: NativeChatToolCallBlock
  revealedDiff?: NativeChatDiffReveal
  expandSignal: boolean
  activeTurnIsWorking?: boolean
  /** This row's tool run is the turn's last, so it is the one still live. */
  trailingRun?: boolean
  /** Hover controls would overlap the next row. */
  continuesTurn?: boolean
  /** Align this message's top to the top of the scroll viewport. */
  onScrollMessageToTop: (el: HTMLElement) => void
  onLinkClick?: CommentMarkdownLinkClickHandler
  allowFileUriLinks?: boolean
  deliveryNotice?: NativeChatDeliveryNotice
  /** On a roster row: its list's state and the subagents whose rows open below it. */
  subagentRoster?: NativeChatSubagentRosterState
  subagentDisclosure?: NativeChatSubagentDisclosure
  /** Inside a subagent's section, whose border has to reach past the row's controls. */
  inSubagentSection?: boolean
  runtimeContext?: RuntimeFileOperationArgs | null
  /** On a user row: discards it and everything after it. */
  rewind?: NativeChatRewindSurface
  /** This row draws a run of tool calls and thoughts: every message in it, `message` first.
   *  The same row either way, so a row becoming a run keeps everything it has mounted. */
  workRun?: readonly NativeChatMessage[]
}

function rowHasContent(content: ReturnType<typeof deriveNativeChatRowContent>): boolean {
  return (
    content.markdown.length > 0 ||
    content.hasImages ||
    content.tools.length > 0 ||
    content.subagentGroups.length > 0 ||
    content.backgroundTasks.length > 0
  )
}

/** One message: its prose first, then a collapsible run folding all of the
 *  turn's tool activity. Monochrome per STYLEGUIDE: user prompts read as a
 *  lifted card, assistant prose as body copy, reasoning de-emphasized.
 *  Memoized: a stream frame republishes the whole transcript, but settled rows
 *  keep their block identity, so only the changed row re-renders. */
export const MessageRow = memo(function MessageRow(
  props: MessageRowProps
): React.JSX.Element | null {
  const {
    message,
    agentName,
    activeTurnIsWorking,
    onScrollMessageToTop,
    onLinkClick,
    allowFileUriLinks = false,
    deliveryNotice,
    runtimeContext,
    rewind,
    workRun
  } = props
  const rowRef = useRef<HTMLDivElement | null>(null)
  const blocks = nativeChatBlocksInOwnWords(message.blocks)
  // One pass per block set, shared with the list that decides whether this row
  // occupies a slot — so "draws nothing" means the same thing to both.
  const content = deriveNativeChatRowContent(blocks)
  const { markdown, prose } = content
  const isUser = message.role === 'user'
  const isReasoning = message.role === 'reasoning'
  const isSystem = message.role === 'system'
  const providerFrame = blocks.find((block) => block.type === 'text' && block.providerFrame)
  const run = useNativeChatWorkRun(workRun, {
    revealedDiff: props.revealedDiff,
    activeTurnIsWorking,
    onLinkClick,
    allowFileUriLinks
  })

  const { scrollToTop, returnToView } = useNativeChatRowNavigation(rowRef, onScrollMessageToTop)

  // Skip rows with nothing renderable so the transcript shows no empty/ghost
  // bubble.
  // After all hooks, so hook order stays unconditional.
  if (run === undefined && !rowHasContent(content)) {
    return null
  }

  const notice = isSystem
    ? blocks.find(
        (block) =>
          block.type === 'text' && (block.presentation !== undefined || block.tone !== undefined)
      )
    : undefined
  if (notice?.type === 'text') {
    return (
      <div ref={rowRef}>
        <NativeChatNoticeRow
          block={notice}
          agentName={agentName}
          onLinkClick={onLinkClick}
          allowFileUriLinks={allowFileUriLinks}
        />
      </div>
    )
  }

  if (providerFrame) {
    return (
      <div ref={rowRef}>
        <ProviderFrameRow block={providerFrame} />
      </div>
    )
  }

  if (isUser) {
    return (
      <div ref={rowRef} className="group relative flex flex-col items-end gap-0.5">
        {/* User turns get a distinct muted fill (not the card/canvas color) so
            the prompt reads apart from the assistant's body copy. */}
        <div className={nativeChatUserMessageClassName()}>
          {markdown ? (
            <>
              <NativeChatImageAttachments
                blocks={prose}
                runtimeContext={runtimeContext}
                enablePreview={runtimeContext !== undefined}
              />
              <CommentMarkdown
                content={markdown}
                variant="document"
                className="text-sm"
                renderCodeBlock={NativeChatCodeBlock}
                onLinkClick={onLinkClick}
                allowFileUriLinks={allowFileUriLinks}
                highlightCode
              />
            </>
          ) : (
            <NativeChatImageAttachments
              blocks={prose}
              runtimeContext={runtimeContext}
              enablePreview={runtimeContext !== undefined}
            />
          )}
        </div>
        {message.sentAs === 'goal' ? (
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Goal className="size-3" aria-hidden />
            <span>{translate('components.native-chat.goal.sentAsGoal', 'Sent as goal')}</span>
          </div>
        ) : null}
        <UserMessageMeta
          markdown={markdown}
          onLinkClick={onLinkClick}
          allowFileUriLinks={allowFileUriLinks}
        />
      </div>
    )
  }

  return (
    <div
      ref={rowRef}
      className={cn(
        'group relative max-w-full select-text text-sm leading-relaxed text-foreground',
        // Reasoning is the agent thinking aloud — quieter, italic, like an aside.
        isReasoning && nativeChatReasoningClassName(),
        isSystem && 'text-xs text-muted-foreground'
      )}
    >
      <NativeChatImageAttachments
        blocks={prose}
        runtimeContext={runtimeContext}
        enablePreview={runtimeContext !== undefined}
      />
      {markdown ? (
        <CommentMarkdown
          content={markdown}
          variant="document"
          className="text-sm"
          renderCodeBlock={NativeChatCodeBlock}
          onLinkClick={onLinkClick}
          allowFileUriLinks={allowFileUriLinks}
          linkifyFilePaths={onLinkClick !== undefined}
          highlightCode
        />
      ) : null}
      {tools.length > 0 || subagentGroups.length > 0 || backgroundTasks.length > 0 ? (
        <NativeChatToolRun
          blocks={tools}
          previousTodoWrite={previousTodoWrite}
          previousUpdatePlan={previousUpdatePlan}
          revealedDiff={revealedDiff}
          onRevealDiff={onScrollMessageToTop}
          onLinkClick={onLinkClick}
          subagentGroups={subagentGroups}
          subagentRoster={subagentRoster}
          subagentDisclosure={subagentDisclosure}
          backgroundTasks={backgroundTasks}
          expandSignal={expandSignal}
          activeTurnIsWorking={activeTurnIsWorking}
          trailing={trailingRun}
          disclosureId={message.id}
        />
      ) : null}
      {showControls ? (
        <NativeChatAgentControls
          markdown={markdown}
          timestamp={message.timestamp}
          onScrollToTop={scrollToTop}
          className={cn(
            'mt-1 w-fit select-none transition-opacity can-hover:pointer-events-none can-hover:opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 [.group:has(:focus-visible)_&]:pointer-events-auto [.group:has(:focus-visible)_&]:opacity-100',
            // They hang into the gap below; a section keeps them inside its border instead.
            !inSubagentSection && '-mb-5'
          )}
        />
      ) : null}
    </div>
  )
}, sameMessageRowProps)

/** A rebuilt transcript hands every run a fresh member list; same messages, same row. */
function sameMessageRowProps(previous: MessageRowProps, next: MessageRowProps): boolean {
  const { workRun: previousRun, ...previousRest } = previous
  const { workRun: nextRun, ...nextRest } = next
  const nextProps = new Map(Object.entries(nextRest))
  return (
    Object.keys(previousRest).length === nextProps.size &&
    Object.entries(previousRest).every(
      ([key, value]) => nextProps.has(key) && Object.is(value, nextProps.get(key))
    ) &&
    previousRun?.length === nextRun?.length &&
    (previousRun ?? []).every((member, index) => member === nextRun?.[index])
  )
}
