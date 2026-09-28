import { AgentQuestionIcon } from '@/components/AgentQuestionIcon'
import { translate } from '@/i18n/i18n'
import { HEIMDALL_FLEET_BUCKET_ORDER, type HeimdallFleetBucket } from './fleet-selectors'

function bucketLabel(bucket: Exclude<HeimdallFleetBucket, 'inactive'>): string {
  switch (bucket) {
    case 'attention':
      return translate('fork.heimdall.sidebar.bucket.attention', 'Needs you')
    case 'lostContact':
      return translate('fork.heimdall.sidebar.bucket.lostContact', 'Lost contact')
    case 'active':
      return translate('fork.heimdall.sidebar.bucket.active', 'Active')
  }
}

/** Displays nonzero fleet indicators without showing inactive watchers. */
export function HeimdallFleetBucketCounts({
  counts
}: {
  counts: Record<HeimdallFleetBucket, number>
}): React.JSX.Element | null {
  const visible = HEIMDALL_FLEET_BUCKET_ORDER.filter(
    (bucket): bucket is Exclude<HeimdallFleetBucket, 'inactive'> =>
      bucket !== 'inactive' && counts[bucket] > 0
  )
  if (visible.length === 0) {
    return null
  }
  return (
    <span className="flex items-center gap-1.5">
      {visible.map((bucket) => (
        <span
          key={bucket}
          aria-label={`${bucketLabel(bucket)}: ${counts[bucket]}`}
          className="inline-flex items-center gap-1 text-[10px] tabular-nums text-worktree-sidebar-foreground/55"
        >
          {bucket === 'attention' ? (
            <AgentQuestionIcon className="size-2.5" />
          ) : bucket === 'lostContact' ? (
            <span className="size-1.5 rounded-full bg-status-warning" />
          ) : (
            <span className="size-1.5 rounded-full bg-status-success" />
          )}
          {counts[bucket]}
        </span>
      ))}
    </span>
  )
}
