import type { JSX, ReactNode } from 'react'
import { useEffect, useId, useState } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import {
  PipelineDocumentSchema,
  PipelineNodeSchema,
  type PipelineDocument,
  type PipelineNode
} from '../../../shared/fork-heimdall-pipeline/document-schema'

export function replacePipelineNode(
  document: PipelineDocument,
  nodeId: string,
  nextNode: PipelineNode
): PipelineDocument {
  return {
    ...document,
    nodes: document.nodes.map((node) => (node.id === nodeId ? nextNode : node))
  }
}

export function Field({
  label,
  children,
  htmlFor
}: {
  label: string
  children: ReactNode
  htmlFor?: string
}): JSX.Element {
  return (
    <div className="grid min-w-0 gap-1.5 [&>label]:text-xs">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  )
}

export function TextField({
  label,
  value,
  onChange,
  disabled = false,
  multiline = false,
  rows = 3
}: {
  label: string
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  multiline?: boolean
  rows?: number
}): JSX.Element {
  const id = useId()
  return (
    <Field label={label} htmlFor={id}>
      {multiline ? (
        <Textarea
          id={id}
          value={value}
          rows={rows}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <Input
          id={id}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </Field>
  )
}

export function NumberField({
  label,
  value,
  onChange,
  disabled = false,
  min,
  max
}: {
  label: string
  value: number | undefined
  onChange: (value: number | undefined) => void
  disabled?: boolean
  min?: number
  max?: number
}): JSX.Element {
  const id = useId()
  return (
    <Field label={label} htmlFor={id}>
      <Input
        id={id}
        type="number"
        step={1}
        min={min}
        max={max}
        value={value ?? ''}
        disabled={disabled}
        onChange={(event) =>
          onChange(event.target.value === '' ? undefined : event.target.valueAsNumber)
        }
      />
    </Field>
  )
}

export function SelectField<Value extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false
}: {
  label: string
  value: Value
  options: readonly { value: Value; label: string }[]
  onChange: (value: Value) => void
  disabled?: boolean
}): JSX.Element {
  const id = useId()
  return (
    <Field label={label} htmlFor={id}>
      <Select
        value={value}
        onValueChange={(next) => {
          const selected = options.find((candidate) => candidate.value === next)
          if (selected) {
            onChange(selected.value)
          }
        }}
        disabled={disabled}
      >
        <SelectTrigger id={id} size="sm" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  )
}

export function BooleanField({
  label,
  value,
  onChange,
  disabled = false
}: {
  label: string
  value: boolean
  onChange: (value: boolean) => void
  disabled?: boolean
}): JSX.Element {
  const id = useId()
  return (
    <div className="flex items-center gap-2 [&>label]:text-xs">
      <Checkbox
        id={id}
        checked={value}
        disabled={disabled}
        onCheckedChange={(checked) => onChange(checked === true)}
      />
      <Label htmlFor={id}>{label}</Label>
    </div>
  )
}

export function JsonField({
  label,
  value,
  disabled = false,
  onChange
}: {
  label: string
  value: unknown
  disabled?: boolean
  onChange: (value: unknown) => boolean
}): JSX.Element {
  const id = useId()
  const [text, setText] = useState(JSON.stringify(value, null, 2) ?? '')
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setText(JSON.stringify(value, null, 2) ?? '')
    setError(null)
  }, [value])
  return (
    <Field label={label} htmlFor={id}>
      <Textarea
        id={id}
        value={text}
        rows={5}
        spellCheck={false}
        disabled={disabled}
        aria-invalid={error !== null}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => {
          try {
            const parsed: unknown = JSON.parse(text)
            setError(
              onChange(parsed)
                ? null
                : translate(
                    'fork.heimdallPipeline.inspector.invalidValue',
                    'This value does not match the pipeline schema.'
                  )
            )
          } catch {
            setError(translate('fork.heimdallPipeline.inspector.invalidJson', 'Enter valid JSON.'))
          }
        }}
      />
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </Field>
  )
}

export function updateDocumentJson(
  document: PipelineDocument,
  key: 'inputs' | 'capabilities' | 'defaults',
  value: unknown,
  onChange: (document: PipelineDocument) => void
): boolean {
  if (key === 'inputs') {
    const parsed = PipelineDocumentSchema.shape.inputs.safeParse(value)
    if (!parsed.success) {
      return false
    }
    onChange({ ...document, inputs: parsed.data })
    return true
  }
  if (key === 'capabilities') {
    const parsed = PipelineDocumentSchema.shape.capabilities.safeParse(value)
    if (!parsed.success) {
      return false
    }
    onChange({ ...document, capabilities: parsed.data })
    return true
  }
  const parsed = PipelineDocumentSchema.shape.defaults.safeParse(value)
  if (!parsed.success) {
    return false
  }
  onChange({ ...document, defaults: parsed.data })
  return true
}

export function updateNodeJson(
  document: PipelineDocument,
  node: PipelineNode,
  key: string,
  value: unknown,
  onChange: (document: PipelineDocument) => void
): boolean {
  const parsedNode = PipelineNodeSchema.safeParse({ ...node, [key]: value })
  if (!parsedNode.success) {
    return false
  }
  onChange(replacePipelineNode(document, node.id, parsedNode.data))
  return true
}

export function option<Value extends string>(
  value: Value,
  label: string
): { value: Value; label: string } {
  return { value, label }
}

export function PipelineNodeInspectorFields({
  document,
  node,
  onNodeChange,
  onDocumentChange
}: {
  document: PipelineDocument
  node: PipelineNode
  onNodeChange: (originalNodeId: string, node: PipelineNode) => void
  onDocumentChange: (document: PipelineDocument) => void
}): JSX.Element {
  const update = (nextNode: PipelineNode): void => onNodeChange(node.id, nextNode)
  const updateJson = (key: string, value: unknown): boolean =>
    updateNodeJson(document, node, key, value, onDocumentChange)

  return (
    <>
      {node.type === 'agent' ? (
        <>
          <TextField
            label={translate('fork.heimdallPipeline.inspector.harness', 'Harness')}
            value={node.harness ?? ''}
            onChange={(harness) => update({ ...node, harness: harness || undefined })}
          />
          <TextField
            label={translate('fork.heimdallPipeline.inspector.model', 'Model')}
            value={node.model ?? ''}
            onChange={(model) => update({ ...node, model: model || undefined })}
          />
          <SelectField
            label={translate('fork.heimdallPipeline.inspector.effort', 'Effort')}
            value={node.effort ?? 'medium'}
            options={[
              option('low', translate('fork.heimdallPipeline.value.low', 'Low')),
              option('medium', translate('fork.heimdallPipeline.value.medium', 'Medium')),
              option('high', translate('fork.heimdallPipeline.value.high', 'High')),
              option('xhigh', translate('fork.heimdallPipeline.value.xhigh', 'Extra high')),
              option('max', translate('fork.heimdallPipeline.value.max', 'Maximum'))
            ]}
            onChange={(effort) => update({ ...node, effort })}
          />
          <TextField
            label={translate('fork.heimdallPipeline.inspector.prompt', 'Prompt')}
            value={node.prompt}
            multiline
            rows={8}
            onChange={(prompt) => update({ ...node, prompt })}
          />
          <JsonField
            label={translate('fork.heimdallPipeline.inspector.outputs', 'Outputs')}
            value={node.outputs ?? {}}
            onChange={(value) => updateJson('outputs', value)}
          />
          <NumberField
            label={translate('fork.heimdallPipeline.inspector.retry', 'Retry count')}
            value={node.retry}
            min={0}
            max={5}
            onChange={(retry) => update({ ...node, retry })}
          />
          <NumberField
            label={translate(
              'fork.heimdallPipeline.inspector.timeLimitMinutes',
              'Time limit (minutes)'
            )}
            value={node.timeLimitMinutes}
            min={1}
            max={1440}
            onChange={(timeLimitMinutes) => update({ ...node, timeLimitMinutes })}
          />
          <TextField
            label={translate(
              'fork.heimdallPipeline.inspector.onFailSendBackTo',
              'On failure, send back to'
            )}
            value={node.onFail?.sendBackTo ?? ''}
            onChange={(sendBackTo) =>
              update({
                ...node,
                onFail: sendBackTo ? { ...node.onFail, sendBackTo } : undefined
              })
            }
          />
        </>
      ) : null}
      {node.type === 'check' ? (
        <>
          <TextField
            label={translate('fork.heimdallPipeline.inspector.command', 'Command')}
            value={node.command}
            multiline
            rows={4}
            onChange={(command) => update({ ...node, command })}
          />
          <NumberField
            label={translate('fork.heimdallPipeline.inspector.timeoutSeconds', 'Timeout (seconds)')}
            value={node.timeoutSeconds}
            min={10}
            max={14400}
            onChange={(timeoutSeconds) => update({ ...node, timeoutSeconds: timeoutSeconds ?? 0 })}
          />
          <NumberField
            label={translate('fork.heimdallPipeline.inspector.retry', 'Retry count')}
            value={node.retry}
            min={0}
            max={5}
            onChange={(retry) => update({ ...node, retry })}
          />
          <TextField
            label={translate(
              'fork.heimdallPipeline.inspector.onFailSendBackTo',
              'On failure, send back to'
            )}
            value={node.onFail?.sendBackTo ?? ''}
            onChange={(sendBackTo) =>
              update({
                ...node,
                onFail: sendBackTo ? { ...node.onFail, sendBackTo } : undefined
              })
            }
          />
        </>
      ) : null}
      {node.type === 'script' ? (
        <>
          <TextField
            label={translate('fork.heimdallPipeline.inspector.command', 'Command')}
            value={node.command}
            multiline
            rows={4}
            onChange={(command) => update({ ...node, command })}
          />
          <SelectField
            label={translate('fork.heimdallPipeline.inspector.capability', 'Capability')}
            value={node.capability}
            options={[
              option('script', translate('fork.heimdallPipeline.value.script', 'Script')),
              option('push', translate('fork.heimdallPipeline.value.push', 'Push')),
              option('land', translate('fork.heimdallPipeline.value.land', 'Land')),
              option('merge', translate('fork.heimdallPipeline.value.merge', 'Merge')),
              option('check', translate('fork.heimdallPipeline.value.check', 'Check'))
            ]}
            onChange={(capability) => update({ ...node, capability })}
          />
          <JsonField
            label={translate('fork.heimdallPipeline.inspector.scriptInputs', 'Environment inputs')}
            value={node.inputs ?? {}}
            onChange={(value) => updateJson('inputs', value)}
          />
          <NumberField
            label={translate('fork.heimdallPipeline.inspector.timeoutSeconds', 'Timeout (seconds)')}
            value={node.timeoutSeconds}
            min={10}
            max={14400}
            onChange={(timeoutSeconds) => update({ ...node, timeoutSeconds })}
          />
          <JsonField
            label={translate('fork.heimdallPipeline.inspector.outputs', 'Outputs')}
            value={node.outputs ?? {}}
            onChange={(value) => updateJson('outputs', value)}
          />
        </>
      ) : null}
      {node.type === 'decision' ? (
        <TextField
          label={translate('fork.heimdallPipeline.inspector.on', 'Output to evaluate')}
          value={node.on}
          onChange={(on) => update({ ...node, on })}
        />
      ) : null}
      {node.type === 'loop' ? (
        <>
          <JsonField
            label={translate('fork.heimdallPipeline.inspector.body', 'Loop body node ids')}
            value={node.body}
            onChange={(value) => updateJson('body', value)}
          />
          <TextField
            label={translate('fork.heimdallPipeline.inspector.until', 'Stop when')}
            value={node.until}
            onChange={(until) => update({ ...node, until })}
          />
          <NumberField
            label={translate('fork.heimdallPipeline.inspector.maxRounds', 'Maximum rounds')}
            value={node.maxRounds}
            min={1}
            max={10}
            onChange={(maxRounds) => update({ ...node, maxRounds: maxRounds ?? 0 })}
          />
        </>
      ) : null}
      {node.type === 'gate' ? (
        <>
          <TextField
            label={translate('fork.heimdallPipeline.inspector.sendBackTo', 'Send back to')}
            value={node.sendBackTo ?? ''}
            onChange={(sendBackTo) => update({ ...node, sendBackTo: sendBackTo || undefined })}
          />
          <BooleanField
            label={translate('fork.heimdallPipeline.inspector.notify', 'Notify the owner')}
            value={node.notify}
            onChange={(notify) => update({ ...node, notify })}
          />
        </>
      ) : null}
      {node.type === 'land' ? (
        <>
          <TextField
            label={translate('fork.heimdallPipeline.inspector.titleField', 'Pull request title')}
            value={node.title ?? ''}
            onChange={(title) => update({ ...node, title: title || undefined })}
          />
          <TextField
            label={translate('fork.heimdallPipeline.inspector.body', 'Pull request body')}
            value={node.body ?? ''}
            multiline
            onChange={(body) => update({ ...node, body: body || undefined })}
          />
          <BooleanField
            label={translate('fork.heimdallPipeline.inspector.draft', 'Open as draft')}
            value={node.draft}
            onChange={(draft) => update({ ...node, draft })}
          />
          <TextField
            label={translate('fork.heimdallPipeline.inspector.commitMessage', 'Commit message')}
            value={node.commitMessage ?? ''}
            onChange={(commitMessage) =>
              update({ ...node, commitMessage: commitMessage || undefined })
            }
          />
        </>
      ) : null}
    </>
  )
}
