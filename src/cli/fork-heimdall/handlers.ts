import type { CommandHandler } from '../dispatch'
import { HEIMDALL_CREATE_HANDLERS } from './create-handler'
import { HEIMDALL_COMMAND_HANDLERS } from './command-handlers'
import { HEIMDALL_READ_HANDLERS } from './read-handlers'

export const HEIMDALL_MANAGE_HANDLERS: Record<string, CommandHandler> = {
  ...HEIMDALL_READ_HANDLERS,
  ...HEIMDALL_COMMAND_HANDLERS
}

export const HEIMDALL_HANDLERS: Record<string, CommandHandler> = {
  ...HEIMDALL_MANAGE_HANDLERS,
  ...HEIMDALL_CREATE_HANDLERS
}
