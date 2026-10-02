import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import { clearSelfWrite, getRecentSelfWrite } from '@/components/editor/editor-self-write-registry'
import {
  readRuntimeFileContent,
  subscribeRuntimeFileChanges,
  type RuntimeFileOperationArgs,
  type RuntimeFileReadArgs
} from '@/runtime/runtime-file-client'

type WatchedPipelineFile = { filePath: string; relativePath: string }

export function watchPipelineFileChanges(
  runtime: RuntimeFileOperationArgs,
  read: Omit<RuntimeFileReadArgs, 'filePath' | 'relativePath'>,
  runtimeEnvironmentId: string | null,
  watchedPaths: Map<string, WatchedPipelineFile>,
  onChange: () => void
): () => void {
  let disposed = false
  let unsubscribe: (() => void) | null = null
  void subscribeRuntimeFileChanges(
    runtime,
    (payload) => {
      const changedFiles = payload.events
        .flatMap((event) => [event.absolutePath, event.oldAbsolutePath])
        .filter((path): path is string => path !== undefined)
        .flatMap((path) => {
          const file = watchedPaths.get(normalizeRuntimePathForComparison(path))
          return file ? [file] : []
        })
      if (changedFiles.length === 0) {
        return
      }
      void (async () => {
        let hasExternalChange = false
        for (const file of changedFiles) {
          const stamp = getRecentSelfWrite(file.filePath, runtimeEnvironmentId)
          if (!stamp || stamp.content === null) {
            hasExternalChange = true
            continue
          }
          try {
            const readArgs: RuntimeFileReadArgs = {
              ...read,
              filePath: file.filePath,
              relativePath: file.relativePath
            }
            const current = await readRuntimeFileContent(readArgs)
            if (!current.isBinary && current.content === stamp.content) {
              clearSelfWrite(file.filePath, runtimeEnvironmentId)
            } else {
              hasExternalChange = true
            }
          } catch {
            hasExternalChange = true
          }
        }
        if (hasExternalChange && !disposed) {
          onChange()
        }
      })()
    },
    () => {
      if (!disposed) {
        onChange()
      }
    }
  )
    .then((cleanup) => {
      if (disposed) {
        cleanup()
      } else {
        unsubscribe = cleanup
      }
    })
    .catch(() => {
      if (!disposed) {
        onChange()
      }
    })
  return () => {
    disposed = true
    unsubscribe?.()
  }
}
