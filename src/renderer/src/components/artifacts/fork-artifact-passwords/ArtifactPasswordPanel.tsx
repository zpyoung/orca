import { useEffect, useRef, useState } from 'react'
import { Check, Copy, Loader2, LockKeyhole, LockOpen, RotateCcw } from 'lucide-react'
import type {
  ArtifactCloudOperation,
  ArtifactPublishedLink,
  ArtifactPublishResult,
  ArtifactWriteRequest
} from '../../../../../shared/artifacts'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { publishArtifactFromSurface } from '../artifact-publish-flow'

const LOCAL_RUNTIME = { kind: 'local' } as const

type Confirmation = 'rotate' | 'remove' | null

export function ArtifactPasswordPanel({
  sourceKey,
  createRequest,
  shareUrl,
  disabled,
  onPublished
}: {
  sourceKey: string
  createRequest: () => Promise<ArtifactWriteRequest>
  shareUrl: string | null
  disabled: boolean
  onPublished: (result: ArtifactPublishResult) => void
}): React.JSX.Element {
  const [details, setDetails] = useState<ArtifactPublishedLink | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [passphrase, setPassphrase] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<Confirmation>(null)
  const sequence = useRef(0)

  useEffect(() => {
    setPassphrase(null)
    setCopied(false)
  }, [sourceKey])

  useEffect(() => {
    const requestSequence = ++sequence.current
    setError(null)
    setDetails(null)
    if (!shareUrl) {
      setPassphrase(null)
      return
    }
    void callRuntimeRpc<ArtifactCloudOperation<ArtifactPublishedLink | null>>(
      LOCAL_RUNTIME,
      'artifacts.getPublishedLink',
      { sourceKey }
    )
      .then((result) => {
        if (sequence.current === requestSequence && result.status === 'ok') {
          setDetails(result.value)
          if (result.value?.protection?.rotationCleanupPending) {
            setError(
              translate(
                'auto.components.artifacts.ArtifactPasswordPanel.rotationIncomplete',
                'The new link works, but the old link may still work. Retry while online.'
              )
            )
          }
        }
      })
      .catch(() => {
        if (sequence.current === requestSequence) {
          setError(
            translate(
              'auto.components.artifacts.ArtifactPasswordPanel.statusFailed',
              'Protection status is unavailable.'
            )
          )
        }
      })
    return () => {
      sequence.current += 1
    }
  }, [shareUrl, sourceKey])

  const runProtectedPublish = async (
    method:
      | 'artifacts.publishProtected'
      | 'artifacts.rotateProtection'
      | 'artifacts.removeProtection'
  ): Promise<void> => {
    if (disabled || busy) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await publishArtifactFromSurface(createRequest, method)
      if (!result) {
        return
      }
      onPublished(result)
      const publication = result.protection
      setDetails({
        shareUrl: result.item.shareUrl,
        protection: publication
          ? {
              state: publication.state,
              ...(publication.passphrase ? { passphrase: publication.passphrase } : {})
            }
          : undefined
      })
      setPassphrase(publication?.passphrase ?? null)
      if (publication?.rotationCleanupPending) {
        setError(
          translate(
            'auto.components.artifacts.ArtifactPasswordPanel.rotationIncomplete',
            'The new link is protected, but Orca could not confirm deletion of the old link. The old link may still work; Orca will retry.'
          )
        )
      }
    } finally {
      setBusy(false)
      setConfirmation(null)
    }
  }

  const reveal = async (): Promise<void> => {
    if (busy) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await callRuntimeRpc<ArtifactCloudOperation<ArtifactPublishedLink | null>>(
        LOCAL_RUNTIME,
        'artifacts.revealPassphrase',
        { sourceKey }
      )
      if (result.status !== 'ok' || !result.value?.protection) {
        throw new Error(result.status)
      }
      setDetails(result.value)
      const revealed = result.value.protection.passphrase
      setPassphrase(revealed ?? null)
      if (!revealed) {
        setError(
          translate(
            'auto.components.artifacts.ArtifactPasswordPanel.passphraseUnavailable',
            'The passphrase is unavailable on this device. You can rotate protection to create a new link and passphrase.'
          )
        )
      }
    } catch {
      setError(
        translate(
          'auto.components.artifacts.ArtifactPasswordPanel.revealFailed',
          'Could not reveal the passphrase.'
        )
      )
    } finally {
      setBusy(false)
    }
  }

  const copyPassphrase = async (): Promise<void> => {
    if (!passphrase) {
      return
    }
    try {
      await window.api.ui.writeClipboardText(passphrase)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1_500)
    } catch {
      setError(
        translate(
          'auto.components.artifacts.ArtifactPasswordPanel.copyFailed',
          'Could not copy the passphrase.'
        )
      )
    }
  }

  const state = details?.protection?.state
  const protectedArtifact = state === 'protected-available' || state === 'protected-unavailable'
  const canProtect = !protectedArtifact && (!shareUrl || state === 'unprotected')

  return (
    <div className="space-y-3 border-b border-border/60 pb-3">
      {canProtect ? (
        <div className="space-y-2">
          <div className="space-y-0.5">
            <p className="flex items-center gap-1.5 text-xs font-medium">
              <LockKeyhole className="size-3.5" />
              {translate(
                'auto.components.artifacts.ArtifactPasswordPanel.protectedTitle',
                'Share with a passphrase'
              )}
            </p>
            <p className="text-[11px] leading-4 text-muted-foreground">
              {translate(
                'auto.components.artifacts.ArtifactPasswordPanel.protectedDescription',
                'Orca encrypts the file before upload and generates a six-word passphrase.'
              )}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full"
            disabled={disabled || busy}
            onClick={() => void runProtectedPublish('artifacts.publishProtected')}
          >
            {busy ? <Loader2 className="animate-spin" /> : <LockKeyhole />}
            {shareUrl
              ? translate(
                  'auto.components.artifacts.ArtifactPasswordPanel.addProtection',
                  'Add passphrase protection'
                )
              : translate(
                  'auto.components.artifacts.ArtifactPasswordPanel.shareProtected',
                  'Share protected link'
                )}
          </Button>
        </div>
      ) : protectedArtifact ? (
        <div className="space-y-2.5">
          <div className="space-y-0.5">
            <p className="flex items-center gap-1.5 text-xs font-medium">
              <LockKeyhole className="size-3.5" />
              {translate(
                'auto.components.artifacts.ArtifactPasswordPanel.protectedStatus',
                'Passphrase protected'
              )}
            </p>
            <p className="text-[11px] leading-4 text-muted-foreground">
              {translate(
                'auto.components.artifacts.ArtifactPasswordPanel.publicCiphertext',
                'Anyone with the link can download the encrypted file. Send the link and passphrase separately.'
              )}
            </p>
          </div>

          {passphrase ? (
            <div className="flex items-center gap-1.5">
              <Input
                readOnly
                value={passphrase}
                aria-label={translate(
                  'auto.components.artifacts.ArtifactPasswordPanel.passphrase',
                  'Artifact passphrase'
                )}
                className="h-8 font-mono text-xs"
              />
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                onClick={() => void copyPassphrase()}
                aria-label={
                  copied
                    ? translate(
                        'auto.components.artifacts.ArtifactPasswordPanel.copied',
                        'Passphrase copied'
                      )
                    : translate(
                        'auto.components.artifacts.ArtifactPasswordPanel.copy',
                        'Copy passphrase'
                      )
                }
              >
                {copied ? <Check /> : <Copy />}
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full"
              disabled={busy || state === 'protected-unavailable'}
              onClick={() => void reveal()}
            >
              {busy ? <Loader2 className="animate-spin" /> : <LockKeyhole />}
              {state === 'protected-unavailable'
                ? translate(
                    'auto.components.artifacts.ArtifactPasswordPanel.unavailable',
                    'Passphrase unavailable'
                  )
                : translate(
                    'auto.components.artifacts.ArtifactPasswordPanel.reveal',
                    'Reveal passphrase'
                  )}
            </Button>
          )}

          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled || busy}
              onClick={() => setConfirmation('rotate')}
            >
              <RotateCcw />
              {translate('auto.components.artifacts.ArtifactPasswordPanel.rotate', 'Rotate')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled || busy}
              onClick={() => setConfirmation('remove')}
            >
              <LockOpen />
              {translate('auto.components.artifacts.ArtifactPasswordPanel.remove', 'Make public')}
            </Button>
          </div>
        </div>
      ) : shareUrl ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.artifacts.ArtifactPasswordPanel.unknown',
            'Protection status is unknown on this version of Orca.'
          )}
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="text-xs leading-4 text-destructive">
          {error}
        </p>
      ) : null}

      <Dialog open={confirmation !== null} onOpenChange={(open) => !open && setConfirmation(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirmation === 'rotate'
                ? translate(
                    'auto.components.artifacts.ArtifactPasswordPanel.rotateTitle',
                    'Rotate passphrase?'
                  )
                : translate(
                    'auto.components.artifacts.ArtifactPasswordPanel.removeTitle',
                    'Remove passphrase protection?'
                  )}
            </DialogTitle>
            <DialogDescription>
              {confirmation === 'rotate'
                ? translate(
                    'auto.components.artifacts.ArtifactPasswordPanel.rotateDescription',
                    'Orca will create a new link and passphrase, then delete the old link. Copies already downloaded cannot be revoked.'
                  )
                : translate(
                    'auto.components.artifacts.ArtifactPasswordPanel.removeDescription',
                    'The same link will become public. Anyone with the link will be able to read the file.'
                  )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {translate('auto.components.artifacts.ArtifactPasswordPanel.cancel', 'Cancel')}
              </Button>
            </DialogClose>
            <Button
              type="button"
              variant={confirmation === 'remove' ? 'destructive' : 'default'}
              disabled={busy}
              onClick={() =>
                void runProtectedPublish(
                  confirmation === 'rotate'
                    ? 'artifacts.rotateProtection'
                    : 'artifacts.removeProtection'
                )
              }
            >
              {busy ? <Loader2 className="animate-spin" /> : null}
              {confirmation === 'rotate'
                ? translate(
                    'auto.components.artifacts.ArtifactPasswordPanel.rotateConfirm',
                    'Create new link'
                  )
                : translate(
                    'auto.components.artifacts.ArtifactPasswordPanel.removeConfirm',
                    'Make public'
                  )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
