import { useCallback, useEffect } from 'react'
import {
  NATIVE_FILE_DROP_TARGET,
  type NativeFileDropPayload
} from '../../../../shared/native-file-drop'

type ComposerDropIdentity = {
  terminalTabId: string
  paneKey: string
}

/** A drop is broadcast to every renderer subscriber, so each composer takes only
 *  the drops addressed to it. An unaddressed payload still lands here, so a
 *  producer that cannot resolve pane identity keeps working. */
function dropAddressesComposer(
  payload: Extract<NativeFileDropPayload, { target: typeof NATIVE_FILE_DROP_TARGET.composer }>,
  { terminalTabId, paneKey }: ComposerDropIdentity
): boolean {
  if (payload.tabId !== undefined && payload.tabId !== terminalTabId) {
    return false
  }
  return payload.paneLeafId === undefined || payload.paneLeafId === paneKey
}

export function useNativeChatFileAttachmentActions(
  attachExternalPaths: (paths: string[]) => void,
  identity: ComposerDropIdentity
): { pickAttachment: () => void } {
  const { terminalTabId, paneKey } = identity
  useEffect(
    () =>
      window.api.ui.onFileDrop((payload) => {
        if (
          payload.target === NATIVE_FILE_DROP_TARGET.composer &&
          dropAddressesComposer(payload, { terminalTabId, paneKey })
        ) {
          attachExternalPaths(payload.paths)
        }
      }),
    [attachExternalPaths, terminalTabId, paneKey]
  )

  const pickAttachment = useCallback(() => {
    void (async () => {
      const filePath = await window.api.shell.pickAttachment()
      if (filePath) {
        attachExternalPaths([filePath])
      }
    })()
  }, [attachExternalPaths])

  return { pickAttachment }
}
