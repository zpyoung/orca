import { lazy, Suspense, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { SecretScanHit } from '@/lib/fork-session-handoff/handoff-secret-scan'

// Why: TerminalPane reaches this dialog, so a static Monaco import lands in every consumer's
// module graph — including node-environment tests that have no `window`.
const HandoffPreviewEditor = lazy(() =>
  import('./HandoffPreviewEditor').then((module) => ({ default: module.HandoffPreviewEditor }))
)
const HANDOFF_PREVIEW_PANEL_ID = 'handoff-brief-preview-panel'

type HandoffPreviewColumnProps = {
  value: string
  safetyBlock: string
  charCount: number
  tokenEstimate: number
  secretHits: SecretScanHit[]
  detached: boolean
  onChange: (value: string) => void
  onRegenerate: () => void
  onDismiss: () => void
}

/**
 * The dialog's preview half, owning its own collapsed/expanded state.
 *
 * Mounted inside DialogContent so a reopened dialog gets a fresh instance, which is what makes
 * the preview default back to expanded without an effect reaching across the open transition.
 */
export function HandoffPreviewColumn({
  value,
  safetyBlock,
  charCount,
  tokenEstimate,
  secretHits,
  detached,
  onChange,
  onRegenerate,
  onDismiss
}: HandoffPreviewColumnProps): React.JSX.Element {
  const [previewOpen, setPreviewOpen] = useState(true)

  return (
    <div className="flex min-h-0 min-w-0 flex-col">
      <Button
        type="button"
        variant="ghost"
        aria-expanded={previewOpen}
        aria-controls={HANDOFF_PREVIEW_PANEL_ID}
        onClick={() => setPreviewOpen((current) => !current)}
        className="m-3 justify-between md:hidden"
      >
        {translate(
          'components.agentSessionContinuation.forkSessionHandoff.showPreview',
          'Brief preview'
        )}
        <ChevronDown
          aria-hidden="true"
          className={previewOpen ? 'rotate-180 transition-transform' : 'transition-transform'}
        />
      </Button>
      <div
        id={HANDOFF_PREVIEW_PANEL_ID}
        role="region"
        aria-label={translate(
          'components.agentSessionContinuation.forkSessionHandoff.preview',
          'Brief preview'
        )}
        className={cn(
          'scrollbar-sleek min-h-0 min-w-0 flex-1 overflow-y-auto p-4 md:block',
          previewOpen ? 'block' : 'hidden'
        )}
      >
        <Suspense fallback={null}>
          <HandoffPreviewEditor
            value={value}
            safetyBlock={safetyBlock}
            charCount={charCount}
            tokenEstimate={tokenEstimate}
            secretHits={secretHits}
            detached={detached}
            onChange={onChange}
            onRegenerate={onRegenerate}
            onDismiss={onDismiss}
          />
        </Suspense>
      </div>
    </div>
  )
}
