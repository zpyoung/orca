const INTERROGATIVE_CUE =
  /\b(should|shall|would|could|can|do|does|did|is|are|was|were|will|may|might|which|what|how|when|where|who|whom|whose|why)\b/i
const CHOICE_CUE =
  /\b(or|either|option|options|prefer|choose|pick|confirm|proceed|let me know|want me to|approve)\b/i
const ENUMERATED_CHOICE = /^\s*(?:\d+[.)]|[-*]|\(?[a-z]\))\s+\S/im

function finalParagraph(text: string): string {
  const withoutFences = text.replace(/```[\s\S]*?```/g, '\n\n')
  const paragraphs = withoutFences
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
  return paragraphs.at(-1) ?? ''
}

/**
 * Whether a worker's last message reads as a question left for someone to answer: a `?` in its
 * final paragraph, plus an interrogative word or a choice cue. Deterministic and deliberately
 * narrow, since a match parks the watcher for a human.
 */
export function looksLikeProseQuestion(message: string | null | undefined): boolean {
  if (!message) {
    return false
  }
  const paragraph = finalParagraph(message)
  if (!paragraph.includes('?')) {
    return false
  }
  return (
    INTERROGATIVE_CUE.test(paragraph) ||
    CHOICE_CUE.test(paragraph) ||
    ENUMERATED_CHOICE.test(paragraph)
  )
}
