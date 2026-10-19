import type { OpenFile } from '@/store/slices/editor'
import { scrollTopCache } from '@/lib/scroll-cache'
import {
  disposeUnattachedMonacoModelsByPathPrefixes,
  getDiffViewerMonacoModelPathPrefixes,
  type MonacoModelRegistry,
  type DisposableMonacoModel
} from './diff-monaco-model-disposal'
import { toEditorModelUri } from './editor-model-uri'

export type ClosedEditorTab = Pick<OpenFile, 'id' | 'mode' | 'filePath'> & {
  modelOwnerKey?: string
}

// One registry sweep avoids quadratic close-all work.
export function disposeClosedEditorModels(
  monacoRegistry: MonacoModelRegistry,
  closedFiles: readonly ClosedEditorTab[],
  onAttachedModel?: (model: DisposableMonacoModel, file: ClosedEditorTab) => void,
  isStillClosed: (file: ClosedEditorTab) => boolean = () => true
): void {
  if (closedFiles.length === 0) {
    return
  }

  const diffFilesByPrefix = new Map<string, ClosedEditorTab>()
  for (const closedFile of closedFiles) {
    if (!isStillClosed(closedFile)) {
      continue
    }
    if (closedFile.mode === 'edit') {
      const model = monacoRegistry.editor.getModel(
        monacoRegistry.Uri.parse(toEditorModelUri(closedFile.filePath, closedFile.modelOwnerKey))
      )
      if (model?.isAttachedToEditor()) {
        onAttachedModel?.(model, closedFile)
      } else {
        model?.dispose()
      }
    } else if (closedFile.mode === 'diff') {
      const { originalModelPathPrefix, modifiedModelPathPrefix } =
        getDiffViewerMonacoModelPathPrefixes(closedFile.id)
      diffFilesByPrefix.set(originalModelPathPrefix, closedFile)
      diffFilesByPrefix.set(modifiedModelPathPrefix, closedFile)
    }
  }

  disposeUnattachedMonacoModelsByPathPrefixes(
    monacoRegistry,
    [...diffFilesByPrefix.keys()],
    (model, prefix) => {
      const file = diffFilesByPrefix.get(prefix)
      if (file) {
        onAttachedModel?.(model, file)
      }
    },
    (prefix) => {
      const file = diffFilesByPrefix.get(prefix)
      return file !== undefined && isStillClosed(file)
    }
  )
}
export function disposeClosedCheckDetailsReadingCache(
  closedFiles: readonly ClosedEditorTab[],
  isStillClosed: (file: ClosedEditorTab) => boolean = () => true
): void {
  for (const closedFile of closedFiles) {
    if (closedFile.mode !== 'check-details' || !isStillClosed(closedFile)) {
      continue
    }
    switch (closedFile.mode) {
      case 'edit':
        scrollTopCache.delete(closedFile.filePath)
        scrollTopCache.delete(`${closedFile.filePath}:rich`)
        scrollTopCache.delete(`${closedFile.filePath}:preview`)
        scrollTopCache.delete(`${closedFile.filePath}:mermaid-diagram`)
        editorSelectionCache.delete(closedFile.filePath)
        scrollTopOwners.push(closedFile.filePath)
        editorSelectionOwners.push(closedFile.filePath)
        closedPdfFilePaths.push(closedFile.filePath)
        break
      case 'markdown-preview':
        scrollTopCache.delete(`${closedFile.id}:preview`)
        scrollTopOwners.push(closedFile.id)
        break
      case 'diff':
        diffViewStateCache.delete(closedFile.id)
        diffViewStateOwners.push(closedFile.id)
        scrollTopCache.delete(`${closedFile.id}:preview`)
        scrollTopOwners.push(closedFile.id)
        break
      case 'conflict-review':
        break
      case 'check-details':
      case 'chat-visual':
        break
    }
  }
}
