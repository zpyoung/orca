import { useState } from 'react'
import { Check, Copy, ExternalLink, Loader2, LockKeyhole } from 'lucide-react'
import type {
  ArtifactCloudOperation,
  ArtifactListItem,
  ArtifactPublishedLink
} from '../../../../../shared/artifacts'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { openArtifactInBrowser } from '../artifact-link-actions'
import { artifactProtectionState } from './artifact-protection-display'

const LOCAL_RUNTIME = { kind: 'local' } as const

export function ArtifactProtectedDetail({ item }: { item: ArtifactListItem }): React.JSX.Element {
  const [passphrase, setPassphrase] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const state = artifactProtectionState(item)
  const sourceKey = item.local?.sourceKey

  const reveal = async (): Promise<void> => {
    if (!sourceKey || busy) {
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
      const revealed = result.status === 'ok' ? result.value?.protection?.passphrase : undefined
      if (!revealed) {
        setError(
          translate(
            'auto.components.artifacts.ArtifactProtectedDetail.unavailable',
            'The passphrase is unavailable on this device. Open the source file to rotate protection, or delete the artifact.'
          )
        )
        return
      }
      setPassphrase(revealed)
    } catch {
      setError(
        translate(
          'auto.components.artifacts.ArtifactProtectedDetail.revealFailed',
          'Could not reveal the passphrase.'
        )
      )
    } finally {
      setBusy(false)
    }
  }

  const copy = async (): Promise<void> => {
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
          'auto.components.artifacts.ArtifactProtectedDetail.copyFailed',
          'Could not copy the passphrase.'
        )
      )
    }
  }

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-editor-surface p-6">
      <section className="w-full max-w-lg space-y-4 rounded-lg border border-border bg-background p-5">
        <div className="space-y-1">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <LockKeyhole className="size-4" />
            {state === 'unknown'
              ? translate(
                  'auto.components.artifacts.ArtifactProtectedDetail.unknownTitle',
                  'Protection status unknown'
                )
              : translate(
                  'auto.components.artifacts.ArtifactProtectedDetail.title',
                  'Passphrase-protected artifact'
                )}
          </h2>
          <p className="text-xs leading-5 text-muted-foreground">
            {translate(
              'auto.components.artifacts.ArtifactProtectedDetail.browserOnly',
              'Orca does not load protected share pages inside the app. Open this artifact in your browser and enter the passphrase there.'
            )}
          </p>
        </div>

        {passphrase ? (
          <div className="space-y-1.5">
            <label htmlFor="artifact-detail-passphrase" className="text-xs font-medium">
              {translate(
                'auto.components.artifacts.ArtifactProtectedDetail.passphrase',
                'Passphrase'
              )}
            </label>
            <div className="flex items-center gap-2">
              <Input
                id="artifact-detail-passphrase"
                readOnly
                value={passphrase}
                className="font-mono text-xs"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => void copy()}
                aria-label={
                  copied
                    ? translate(
                        'auto.components.artifacts.ArtifactProtectedDetail.copied',
                        'Passphrase copied'
                      )
                    : translate(
                        'auto.components.artifacts.ArtifactProtectedDetail.copy',
                        'Copy passphrase'
                      )
                }
              >
                {copied ? <Check /> : <Copy />}
              </Button>
            </div>
          </div>
        ) : sourceKey && state !== 'unknown' ? (
          <Button
            type="button"
            variant="outline"
            className="w-full"
            disabled={busy}
            onClick={() => void reveal()}
          >
            {busy ? <Loader2 className="animate-spin" /> : <LockKeyhole />}
            {translate(
              'auto.components.artifacts.ArtifactProtectedDetail.reveal',
              'Reveal passphrase'
            )}
          </Button>
        ) : (
          <p className="text-xs leading-5 text-muted-foreground">
            {translate(
              'auto.components.artifacts.ArtifactProtectedDetail.noLocalRecord',
              'This device does not have the local protection record or passphrase.'
            )}
          </p>
        )}

        {error ? (
          <p role="alert" className="text-xs leading-5 text-destructive">
            {error}
          </p>
        ) : null}

        <Button
          type="button"
          className="w-full"
          onClick={() => openArtifactInBrowser(item.shareUrl)}
        >
          <ExternalLink />
          {translate('auto.components.artifacts.ArtifactProtectedDetail.open', 'Open in browser')}
        </Button>

        <p className="text-[11px] leading-4 text-muted-foreground">
          {translate(
            'auto.components.artifacts.ArtifactProtectedDetail.caution',
            'The encrypted file is publicly downloadable. Enter the passphrase only on a share page you trust. Decrypted HTML can run scripts from its publisher.'
          )}
        </p>
      </section>
    </div>
  )
}
