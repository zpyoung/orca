import {
  notApplicableDisposition,
  type WslMoveFieldDisposition
} from '../wsl-move/wsl-move-dispositions'

const NOT_MOVED = notApplicableDisposition(
  62,
  'Agent loop runs and their iteration history; the WSL project mover does not carry or rewrite them.'
)

export const LOOPS_SQLITE_SCHEMA_FILE_DATABASES: Record<string, string> = {
  'src/main/fork-loops/loop-database.ts': 'loops'
}

export const LOOPS_SQLITE_TABLE_DISPOSITIONS: Record<string, WslMoveFieldDisposition> = {
  'loops.loops': NOT_MOVED,
  'loops.iterations': NOT_MOVED,
  'loops.queue_items': NOT_MOVED,
  'loops.steer_notes': NOT_MOVED
}
