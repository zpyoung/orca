import { lazy, Suspense } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'

const ObjectiveEnrollmentSheet = lazy(() =>
  import('../fork-heimdall-objective/ObjectiveEnrollmentSheet').then((module) => ({
    default: module.ObjectiveEnrollmentSheet
  }))
)

export type PipelineCanvasRunDialogsProps = {
  replaceFileOpen: boolean
  onReplaceFileOpenChange: (open: boolean) => void
  onReplaceFile: () => void
  saveToChoiceOpen: boolean
  onSaveToChoiceOpenChange: (open: boolean) => void
  onChooseSaveScope: (scope: 'repo' | 'user') => void
  unsavedRunOpen: boolean
  onUnsavedRunOpenChange: (open: boolean) => void
  onSaveAndRun: () => void
  saving: boolean
  runSheetOpen: boolean
  onRunSheetOpenChange: (open: boolean) => void
  initialPipelineRef: string
  initialWorktreeId: string
}

export function PipelineCanvasRunDialogs({
  replaceFileOpen,
  onReplaceFileOpenChange,
  onReplaceFile,
  saveToChoiceOpen,
  onSaveToChoiceOpenChange,
  onChooseSaveScope,
  unsavedRunOpen,
  onUnsavedRunOpenChange,
  onSaveAndRun,
  saving,
  runSheetOpen,
  onRunSheetOpenChange,
  initialPipelineRef,
  initialWorktreeId
}: PipelineCanvasRunDialogsProps): React.JSX.Element {
  return (
    <>
      <Dialog open={replaceFileOpen} onOpenChange={onReplaceFileOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {translate('fork.heimdallPipeline.dialog.replaceTitle', 'Replace pipeline file?')}
            </DialogTitle>
            <DialogDescription>
              {translate(
                'fork.heimdallPipeline.dialog.replaceDescription',
                'Replace the file with the canvas version (comments will be lost).'
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onReplaceFileOpenChange(false)}>
              {translate('fork.heimdallPipeline.dialog.cancel', 'Cancel')}
            </Button>
            <Button type="button" variant="destructive" onClick={onReplaceFile} disabled={saving}>
              {translate('fork.heimdallPipeline.dialog.replace', 'Replace file')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={saveToChoiceOpen} onOpenChange={onSaveToChoiceOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {translate('fork.heimdallPipeline.saveTo.title', 'Save pipeline to')}
            </DialogTitle>
            <DialogDescription>
              {translate(
                'fork.heimdallPipeline.saveTo.description',
                'Choose where this pipeline is saved.'
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onSaveToChoiceOpenChange(false)}>
              {translate('fork.heimdallPipeline.dialog.cancel', 'Cancel')}
            </Button>
            <Button type="button" onClick={() => onChooseSaveScope('repo')} disabled={saving}>
              {translate('fork.heimdallPipeline.saveTo.repo', 'This repo')}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => onChooseSaveScope('user')}
              disabled={saving}
            >
              {translate('fork.heimdallPipeline.saveTo.personal', 'My pipelines')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={unsavedRunOpen} onOpenChange={onUnsavedRunOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {translate('fork.heimdallPipeline.runUnsaved.title', 'Save changes before running?')}
            </DialogTitle>
            <DialogDescription>
              {translate(
                'fork.heimdallPipeline.runUnsaved.description',
                'A run always starts from the saved pipeline file. Save these edits before choosing run inputs.'
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onUnsavedRunOpenChange(false)}>
              {translate('fork.heimdallPipeline.dialog.cancel', 'Cancel')}
            </Button>
            <Button type="button" disabled={saving} onClick={onSaveAndRun}>
              {translate('fork.heimdallPipeline.runUnsaved.saveAndRun', 'Save and run')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Suspense fallback={null}>
        <ObjectiveEnrollmentSheet
          open={runSheetOpen}
          onOpenChange={onRunSheetOpenChange}
          initialPipelineRef={initialPipelineRef}
          initialWorktreeId={initialWorktreeId}
        />
      </Suspense>
    </>
  )
}
