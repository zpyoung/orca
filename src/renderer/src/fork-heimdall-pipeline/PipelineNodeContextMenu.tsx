import {
  useCallback,
  useRef,
  useState,
  type HTMLAttributes,
  type MouseEvent,
  type ReactNode
} from 'react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { translate } from '@/i18n/i18n'

export type PipelineNodeContextMenuItem = {
  key: string
  label: string
  onSelect: () => void
  destructive?: boolean
}

type PipelineNodeContextMenuProps<TNode extends { id: string }> = Omit<
  HTMLAttributes<HTMLDivElement>,
  'children' | 'onContextMenu' | 'onContextMenuCapture'
> & {
  /** Items for the right-clicked node; read at render time so they never go stale while open. */
  getItems: (node: TNode) => readonly PipelineNodeContextMenuItem[]
  /** Renders the flow; hand the given handler to React Flow's `onNodeContextMenu`. */
  children: (onNodeContextMenu: (event: MouseEvent, node: TNode) => void) => ReactNode
}

/**
 * Wraps a graph's flow container so a right-click on a node opens a menu of caller-supplied
 * items and a right-click anywhere else (pane, edge, controls) opens nothing.
 */
export function PipelineNodeContextMenu<TNode extends { id: string }>({
  getItems,
  children,
  ...containerProps
}: PipelineNodeContextMenuProps<TNode>): React.JSX.Element {
  const recordedNodeRef = useRef<TNode | null>(null)
  const [target, setTarget] = useState<TNode | null>(null)
  const onNodeContextMenu = useCallback((_event: MouseEvent, node: TNode): void => {
    recordedNodeRef.current = node
    setTarget(node)
  }, [])
  const items = target ? getItems(target) : []

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          {...containerProps}
          onContextMenuCapture={() => {
            recordedNodeRef.current = null
          }}
          onContextMenu={(event) => {
            // radix skips opening on a defaultPrevented event, which is how non-node clicks stay closed
            if (recordedNodeRef.current === null) {
              event.preventDefault()
            }
          }}
        >
          {children(onNodeContextMenu)}
        </div>
      </ContextMenuTrigger>
      {items.length > 0 ? (
        <ContextMenuContent>
          {items.map((item) => (
            <ContextMenuItem
              key={item.key}
              variant={item.destructive ? 'destructive' : 'default'}
              onSelect={item.onSelect}
            >
              {item.label}
            </ContextMenuItem>
          ))}
        </ContextMenuContent>
      ) : null}
    </ContextMenu>
  )
}

export function copyNodeIdMenuItem(nodeId: string): PipelineNodeContextMenuItem {
  return {
    key: 'copy-node-id',
    label: translate('fork.heimdallPipeline.contextMenu.copyNodeId', 'Copy node ID'),
    onSelect: () => {
      void window.api.ui.writeClipboardText(nodeId)
    }
  }
}
