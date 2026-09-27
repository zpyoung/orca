import React from 'react'
import { GitBranch } from 'lucide-react'

/**
 * The Source Control activity-bar glyph carrying a dirty dot.
 *
 * Drops into `ActivityBarItem['icon']`, so it has to look right at every size
 * the bar renders — 16px in the top strip, 18px in the side rail, 14px in the
 * overflow menu — and on every surface those use. The dot sits in the glyph's
 * empty lower-right quadrant and carries no ring, since the menu surface is
 * `popover` while the bars are `sidebar`.
 */
export function SourceControlDirtyIcon({
  size = 16,
  className
}: {
  size?: number
  className?: string
}): React.JSX.Element {
  const dotSize = Math.max(5, Math.round(size * 0.375))

  return (
    <span
      className="relative inline-flex shrink-0"
      style={{ width: size, height: size }}
      data-testid="source-control-dirty-icon"
    >
      <GitBranch size={size} className={className} />
      <span
        aria-hidden
        className="absolute rounded-full"
        style={{
          width: dotSize,
          height: dotSize,
          right: -2,
          bottom: -2,
          background: 'var(--git-decoration-modified)'
        }}
      />
    </span>
  )
}
