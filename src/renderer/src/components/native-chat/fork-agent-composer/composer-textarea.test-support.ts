import { fireEvent } from '@testing-library/react'

/** The agent composer's field is a textarea; these mirror the prompt-editor test helpers. */
function composerTextarea(element: HTMLElement): HTMLTextAreaElement {
  if (!(element instanceof HTMLTextAreaElement)) {
    throw new Error('Expected the agent composer textarea.')
  }
  return element
}

export function promptValue(element: HTMLElement): string {
  return composerTextarea(element).value
}

export function changePrompt(element: HTMLElement, value: string): void {
  fireEvent.change(composerTextarea(element), { target: { value } })
}
