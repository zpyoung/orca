import type { JSX } from 'react'
import { translate } from '@/i18n/i18n'
import type {
  PipelineDocument,
  PipelineNode
} from '../../../shared/fork-heimdall-pipeline/document-schema'
import {
  BooleanField,
  JsonField,
  NumberField,
  SelectField,
  TextField,
  option,
  updateNodeJson
} from './pipeline-node-inspector-fields'

type CompositePipelineNode = Extract<
  PipelineNode,
  { type: 'swarm' | 'merge' | 'objective' | 'pr-sitter' }
>

export function PipelineNodeInspectorCompositeFields({
  document,
  node,
  onDocumentChange,
  onNodeChange
}: {
  document: PipelineDocument
  node: CompositePipelineNode
  onDocumentChange: (document: PipelineDocument) => void
  onNodeChange: (originalNodeId: string, node: PipelineNode) => void
}): JSX.Element {
  const update = (nextNode: PipelineNode): void => onNodeChange(node.id, nextNode)
  const updateJson = (key: string, value: unknown): boolean =>
    updateNodeJson(document, node, key, value, onDocumentChange)

  if (node.type === 'swarm') {
    return (
      <>
        <TextField
          label={translate('fork.heimdallPipeline.inspector.from', 'Tasks from')}
          value={node.from}
          onChange={(from) => update({ ...node, from })}
        />
        <NumberField
          label={translate('fork.heimdallPipeline.inspector.maxParallel', 'Maximum parallel tasks')}
          value={node.maxParallel}
          min={1}
          max={5}
          onChange={(maxParallel) => update({ ...node, maxParallel: maxParallel ?? 0 })}
        />
        <SelectField
          label={translate('fork.heimdallPipeline.inspector.worktree', 'Worktree')}
          value={node.worktree}
          options={[
            option('own', translate('fork.heimdallPipeline.value.ownWorktree', 'Own worktree')),
            option(
              'shared',
              translate('fork.heimdallPipeline.value.sharedWorktree', 'Shared worktree')
            )
          ]}
          onChange={(worktree) => update({ ...node, worktree })}
        />
        <TextField
          label={translate('fork.heimdallPipeline.inspector.childHarness', 'Child harness')}
          value={node.child.harness}
          onChange={(harness) => update({ ...node, child: { ...node.child, harness } })}
        />
        <TextField
          label={translate('fork.heimdallPipeline.inspector.childModel', 'Child model')}
          value={node.child.model ?? ''}
          onChange={(model) =>
            update({ ...node, child: { ...node.child, model: model || undefined } })
          }
        />
        <SelectField
          label={translate('fork.heimdallPipeline.inspector.childEffort', 'Child effort')}
          value={node.child.effort ?? 'medium'}
          options={[
            option('low', translate('fork.heimdallPipeline.value.low', 'Low')),
            option('medium', translate('fork.heimdallPipeline.value.medium', 'Medium')),
            option('high', translate('fork.heimdallPipeline.value.high', 'High')),
            option('xhigh', translate('fork.heimdallPipeline.value.xhigh', 'Extra high')),
            option('max', translate('fork.heimdallPipeline.value.max', 'Maximum'))
          ]}
          onChange={(effort) => update({ ...node, child: { ...node.child, effort } })}
        />
        <TextField
          label={translate('fork.heimdallPipeline.inspector.childPrompt', 'Child prompt')}
          value={node.child.prompt}
          multiline
          rows={6}
          onChange={(prompt) => update({ ...node, child: { ...node.child, prompt } })}
        />
        <JsonField
          label={translate('fork.heimdallPipeline.inspector.childOutputs', 'Child outputs')}
          value={node.child.outputs ?? {}}
          onChange={(value) => updateJson('child', { ...node.child, outputs: value })}
        />
        <NumberField
          label={translate('fork.heimdallPipeline.inspector.childRetry', 'Child retry count')}
          value={node.child.retry}
          min={0}
          max={5}
          onChange={(retry) => update({ ...node, child: { ...node.child, retry } })}
        />
        <NumberField
          label={translate(
            'fork.heimdallPipeline.inspector.childTimeLimitMinutes',
            'Child time limit (minutes)'
          )}
          value={node.child.timeLimitMinutes}
          min={1}
          max={1440}
          onChange={(timeLimitMinutes) =>
            update({ ...node, child: { ...node.child, timeLimitMinutes } })
          }
        />
      </>
    )
  }

  if (node.type === 'merge') {
    return (
      <TextField
        label={translate('fork.heimdallPipeline.inspector.mergeFrom', 'Swarm node')}
        value={node.from}
        onChange={(from) => update({ ...node, from })}
      />
    )
  }

  if (node.type === 'objective') {
    return (
      <>
        <SelectField
          label={translate('fork.heimdallPipeline.inspector.tier', 'Tier')}
          value={node.tier}
          options={[
            option('express', translate('fork.heimdallPipeline.value.express', 'Express')),
            option('standard', translate('fork.heimdallPipeline.value.standard', 'Standard')),
            option('full', translate('fork.heimdallPipeline.value.full', 'Full'))
          ]}
          onChange={(tier) => update({ ...node, tier })}
        />
        <SelectField
          label={translate('fork.heimdallPipeline.inspector.landingBar', 'Landing bar')}
          value={node.landingBar}
          options={[
            option(
              'files-on-disk',
              translate('fork.heimdallPipeline.value.filesOnDisk', 'Files on disk')
            ),
            option(
              'committed-local-branch',
              translate('fork.heimdallPipeline.value.localBranch', 'Committed local branch')
            ),
            option('pushed-ref', translate('fork.heimdallPipeline.value.pushedRef', 'Pushed ref')),
            option(
              'hosted-review',
              translate('fork.heimdallPipeline.value.hostedReview', 'Hosted review')
            ),
            option('merged', translate('fork.heimdallPipeline.value.merged', 'Merged'))
          ]}
          onChange={(landingBar) => update({ ...node, landingBar })}
        />
        <JsonField
          label={translate('fork.heimdallPipeline.inspector.objectiveChecks', 'Checks')}
          value={node.checks ?? []}
          onChange={(value) => updateJson('checks', value)}
        />
        <JsonField
          label={translate('fork.heimdallPipeline.inspector.roleAgents', 'Role agents')}
          value={node.roleAgents ?? {}}
          onChange={(value) => updateJson('roleAgents', value)}
        />
        <NumberField
          label={translate('fork.heimdallPipeline.inspector.maxConcurrency', 'Maximum concurrency')}
          value={node.maxConcurrency}
          min={1}
          max={16}
          onChange={(maxConcurrency) => update({ ...node, maxConcurrency })}
        />
        <BooleanField
          label={translate(
            'fork.heimdallPipeline.inspector.lanesEnabled',
            'Keep dependent work in lanes'
          )}
          value={node.lanesEnabled ?? true}
          onChange={(lanesEnabled) => update({ ...node, lanesEnabled })}
        />
      </>
    )
  }

  return (
    <>
      <NumberField
        label={translate('fork.heimdallPipeline.inspector.repeatFixLimit', 'Repeated fix limit')}
        value={node.repeatFixLimit}
        min={1}
        max={10}
        onChange={(repeatFixLimit) => update({ ...node, repeatFixLimit: repeatFixLimit ?? 0 })}
      />
      <SelectField
        label={translate('fork.heimdallPipeline.inspector.branchUpdateMode', 'Branch update mode')}
        value={node.branchUpdateMode ?? 'merge-base-update'}
        options={[
          option(
            'merge-base-update',
            translate('fork.heimdallPipeline.value.mergeBaseUpdate', 'Merge base update')
          ),
          option('rebase', translate('fork.heimdallPipeline.value.rebase', 'Rebase'))
        ]}
        onChange={(branchUpdateMode) => update({ ...node, branchUpdateMode })}
      />
      <SelectField
        label={translate('fork.heimdallPipeline.inspector.mergeMethod', 'Merge method')}
        value={node.mergeMethod ?? 'none'}
        options={[
          option('none', translate('fork.heimdallPipeline.value.noOverride', 'No override')),
          option('merge', translate('fork.heimdallPipeline.value.merge', 'Merge')),
          option('squash', translate('fork.heimdallPipeline.value.squash', 'Squash')),
          option('rebase', translate('fork.heimdallPipeline.value.rebase', 'Rebase'))
        ]}
        onChange={(mergeMethod) =>
          update({
            ...node,
            mergeMethod: mergeMethod === 'none' ? null : mergeMethod
          })
        }
      />
      <SelectField
        label={translate('fork.heimdallPipeline.inspector.mergeCheckScope', 'Merge check scope')}
        value={node.mergeCheckScope}
        options={[
          option(
            'required',
            translate('fork.heimdallPipeline.value.requiredChecks', 'Required checks')
          ),
          option('all', translate('fork.heimdallPipeline.value.allChecks', 'All checks'))
        ]}
        onChange={(mergeCheckScope) => update({ ...node, mergeCheckScope })}
      />
    </>
  )
}
