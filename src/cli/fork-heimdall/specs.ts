import type { CommandSpec } from '../args'
import { HEIMDALL_CREATE_SPECS } from './specs-create'
import { HEIMDALL_MANAGE_SPECS } from './specs-manage'

export const HEIMDALL_COMMAND_SPECS: CommandSpec[] = [
  ...HEIMDALL_MANAGE_SPECS,
  ...HEIMDALL_CREATE_SPECS
]
