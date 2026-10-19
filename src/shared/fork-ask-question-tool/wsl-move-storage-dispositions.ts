import {
  notApplicableDisposition,
  type WslMoveFieldDisposition
} from '../wsl-move/wsl-move-dispositions'

const NOT_MOVED = notApplicableDisposition(
  62,
  'Pending agent questions; the WSL project mover does not carry or rewrite them.'
)

export const ASK_SQLITE_SCHEMA_FILE_DATABASES: Record<string, string> = {
  'src/main/fork-ask-question-tool/ask-db.ts': 'ask'
}

export const ASK_SQLITE_TABLE_DISPOSITIONS: Record<string, WslMoveFieldDisposition> = {
  'ask.asks': NOT_MOVED,
  'ask.ask_seq': NOT_MOVED
}
