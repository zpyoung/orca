import type { CheckOutcome, LoopConfig } from './loop-types'

const PREVIOUS_CHECK_TAIL_LINES = 40

// No line may start with a marker name: the agent's echo of this text must never parse as a marker.
export const LOOP_PREAMBLE = [
  'You are running inside an automated loop. Each iteration you receive the same task again.',
  'Keep progress notes in the notes file so the next iteration can pick up where you left off.',
  'When the whole task is finished, print the word LOOP_DONE on a line by itself.',
  'If you cannot continue, print LOOP_BLOCKED followed by a colon and the reason, on one line.',
  'If you need a human decision, print LOOP_DECIDE followed by a colon and the question, on one line.',
  'Never print those words on their own line for any other reason.'
].join('\n')

export type ComposeIterationPromptArgs = {
  loop: LoopConfig
  iteration: number
  maxIterations: number | null
  previousCheck: CheckOutcome | null
  steerNotes: string[]
  body: string
  notesPath: string
  includePreamble: boolean
}

function lastLines(text: string, count: number): string {
  return text.trimEnd().split('\n').slice(-count).join('\n')
}

/**
 * Builds the text sent to the agent for one iteration: optional preamble, an
 * iteration header (with the last 40 lines of a failed previous check), steer
 * notes, then the loop body. Callers decide which steer notes to pass so each
 * is consumed by exactly one sent iteration.
 */
export function composeIterationPrompt(args: ComposeIterationPromptArgs): string {
  const sections: string[] = []
  if (args.includePreamble) {
    sections.push(`${LOOP_PREAMBLE}\nNotes file: ${args.notesPath}`)
  }

  const header =
    args.maxIterations === null
      ? `This is iteration ${args.iteration}.`
      : `This is iteration ${args.iteration} of ${args.maxIterations}.`
  const headerLines = [header]
  const check = args.previousCheck
  if (check && check.ran && !check.pass) {
    const output = lastLines(
      [check.stdoutTail, check.stderrTail].filter(Boolean).join('\n'),
      PREVIOUS_CHECK_TAIL_LINES
    )
    headerLines.push('The previous check failed. Its last output:', output)
  }
  sections.push(headerLines.join('\n'))

  if (args.steerNotes.length > 0) {
    sections.push(
      [
        'Notes from the user for this iteration:',
        ...args.steerNotes.map((note) => `- ${note}`)
      ].join('\n')
    )
  }

  sections.push(args.body)
  return sections.join('\n\n')
}
