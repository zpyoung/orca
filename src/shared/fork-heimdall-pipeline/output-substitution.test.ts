import { describe, expect, it } from 'vitest'
import { ORCHESTRATION_WORKER_START_TASK_SPEC_MAX_BYTES } from '../orchestration-worker-start-prompt-budget'
import { findOutputRefs, renderPrompt, type RenderPromptResult } from './output-substitution'

function renderedText(result: RenderPromptResult): string {
  if (!result.ok) {
    throw new Error('Expected rendered prompt to fit the task specification limit')
  }
  return result.text
}

describe('pipeline output substitution', () => {
  it('finds output, input and task references in source order', () => {
    expect(findOutputRefs('use $planner.outputs.plan and $run.inputs.task and $task.id')).toEqual([
      expect.objectContaining({ kind: 'output', nodeId: 'planner', name: 'plan' }),
      expect.objectContaining({ kind: 'input', name: 'task' }),
      expect.objectContaining({ kind: 'task', field: 'id' })
    ])
  })

  it('renders values by output type and appends engine sections in their fixed order', () => {
    const rendered = renderedText(
      renderPrompt({
        prompt:
          '$run.inputs.task $planner.outputs.text $planner.outputs.json $planner.outputs.tasks $planner.outputs.file $task.id',
        runInputs: { task: 'Fix the bug' },
        task: { id: 't1', title: 'Fix', spec: 'Implement fix' },
        workspacePath: '/workspace',
        outputs: {
          planner: {
            text: { type: { type: 'text' }, value: 'plain text' },
            json: { type: { type: 'json' }, value: { answer: 42 } },
            tasks: {
              type: { type: 'taskList' },
              value: [{ id: 't1', title: 'Fix', spec: 'Implement fix' }]
            },
            file: { type: { type: 'file' }, value: 'reports/../result.txt' }
          }
        },
        retryContext: 'Retry the failed attempt.',
        reviewerObjections: ['Address the test failure.'],
        sendBackComment: 'Keep the change narrow.',
        reportInstructions: 'Write a report file.'
      })
    )
    expect(rendered).toContain('Fix the bug plain text')
    expect(rendered).toContain('```json\n{\n  "answer": 42\n}\n```')
    expect(rendered).toContain(
      '```json\n[\n  {\n    "id": "t1",\n    "title": "Fix",\n    "spec": "Implement fix"\n  }\n]\n```'
    )
    expect(rendered).toContain('/workspace/result.txt')
    const headings = [
      '## Retry context',
      '## Reviewer objections',
      '## Send-back comment',
      '## Report instructions'
    ]
    const headingPositions = headings.map((heading) => rendered.indexOf(heading))
    expect(headingPositions.every((position) => position >= 0)).toBe(true)
    expect(headingPositions).toEqual([...headingPositions].sort((left, right) => left - right))
    const withoutSections = renderedText(
      renderPrompt({ prompt: 'Prompt only.', workspacePath: '/workspace' })
    )
    expect(withoutSections).toBe('Prompt only.')
    expect(withoutSections).not.toContain('## Retry context')
  })

  it('returns a criteria failure when rendered UTF-8 output exceeds the task limit', () => {
    expect(
      renderPrompt({
        prompt: 'x'.repeat(ORCHESTRATION_WORKER_START_TASK_SPEC_MAX_BYTES + 1),
        workspacePath: '/workspace'
      })
    ).toEqual({ ok: false, failureClass: 'criteria' })
  })
})
