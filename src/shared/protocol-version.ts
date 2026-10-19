import { ASK_REGISTRY_RUNTIME_CAPABILITY } from './fork-ask-question-tool/ask-question-capability'
import {
  HEIMDALL_COMMANDS_RUNTIME_CAPABILITY,
  HEIMDALL_WATCHER_DELETE_RUNTIME_CAPABILITY,
  HEIMDALL_WATCHER_ANSWER_ESCALATION_RUNTIME_CAPABILITY,
  HEIMDALL_DISPATCH_RESULT_PRE_DISPATCH_FAILURE_RUNTIME_CAPABILITY,
  HEIMDALL_WATCHER_PARK_REASON_V2_RUNTIME_CAPABILITY,
  HEIMDALL_ENROLL_OWNER_RUNTIME_CAPABILITY,
  HEIMDALL_PARALLEL_EXECUTION_RUNTIME_CAPABILITY,
  HEIMDALL_OBJECTIVE_ROLE_LAUNCH_RUNTIME_CAPABILITY,
  HEIMDALL_HOSTED_REVIEW_DERIVED_PAYLOAD_RUNTIME_CAPABILITY,
  HEIMDALL_HOSTED_REVIEW_CHECK_SCOPE_RUNTIME_CAPABILITY,
  HEIMDALL_OBJECTIVE_NEW_WORKTREE_RUNTIME_CAPABILITY
} from './fork-heimdall/capability'
import { WORKSPACE_ATTACHMENT_RUNTIME_CAPABILITIES } from './workspace-attachment-capabilities'
import { SSH_TARGET_MANAGEMENT_RUNTIME_CAPABILITY } from './ssh-target-management'
import {
  AUTOMATION_RUNTIME_CAPABILITIES,
  AUTOMATION_RUNTIME_CLIENT_CAPABILITIES
} from './automation-runtime-capabilities'
export {
  AUTOMATION_LIST_HOST_SCOPE_RUNTIME_CAPABILITY,
  AUTOMATION_LIST_HOST_SCOPE_UPDATE_REQUIRED_MESSAGE,
  AUTOMATION_OWNER_FENCING_RUNTIME_CAPABILITY,
  AUTOMATION_OWNER_FENCING_UPDATE_REQUIRED_MESSAGE,
  AUTOMATION_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY,
  AUTOMATION_EXTRA_AGENT_ARGS_RUNTIME_CAPABILITY
} from './automation-runtime-capabilities'
import { STRUCTURED_AGENT_SESSION_SURFACE_RUNTIME_CAPABILITIES } from './structured-agent-session-surface-capabilities'
export {
  STRUCTURED_AGENT_SESSION_HOLD_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_REVEAL_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY,
  PI_STRUCTURED_DIALOGS_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_CLI_SOURCE_RUNTIME_CAPABILITY
} from './structured-agent-session-surface-capabilities'
import { AGENT_SESSION_ATTENTION_RUNTIME_CAPABILITIES } from './agent-session-attention-capabilities'
export {
  AGENT_SESSION_STATUS_FEED_RUNTIME_CAPABILITY,
  AGENT_SESSION_TURN_COMPLETION_RUNTIME_CAPABILITY,
  AGENT_SESSION_ATTENTION_ACK_RUNTIME_CAPABILITY
} from './agent-session-attention-capabilities'
import { ORCHESTRATION_RUNTIME_CAPABILITIES } from './orchestration-runtime-capabilities'
export {
  ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_CONTROL_MAIL_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_RUNTIME_CAPABILITY,
  ORCHESTRATION_WORKER_STOP_VERDICT_RUNTIME_CAPABILITY,
  ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_STRUCTURED_READ_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_FLEET_SNAPSHOT_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_RELEASE_ARCHIVE_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_CONTROL_MAIL_PROTOCOL_VERSION,
  ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_PROTOCOL_VERSION,
  ORCHESTRATION_CONTRACT_VERSION,
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY
} from './orchestration-runtime-capabilities'
import { AGENT_SESSION_RESUME_RUNTIME_CAPABILITIES } from './agent-session-resume-runtime-capabilities'
import { QODER_OWNED_TERMINAL_CREATE_CAPABILITY } from './qoder-terminal-create-capability'
import { SESSION_TABS_RUNTIME_CAPABILITIES } from './session-tabs-runtime-capabilities'
export { SESSION_TABS_SPLIT_GROUP_PLACEMENT_RUNTIME_CAPABILITY } from './session-tabs-runtime-capabilities'
import { AGENT_SESSION_CONTINUE_INTERRUPTED_RUNTIME_CAPABILITY } from './agent-session-continue-interrupted-capability'
import { AGENT_SESSION_PERMISSION_MODES_RUNTIME_CAPABILITY } from './agent-session-permission-modes-capability'
import { ORCAD_RUNTIME_CAPABILITIES } from './orcad-runtime-capabilities'
import { DEVICE_KEY_RUNTIME_CAPABILITIES } from './device-key-capability'
import { TERMINAL_QUICK_COMMAND_RUNTIME_CAPABILITIES } from './terminal-quick-command-capabilities'
// Why a star: every resume capability is part of the runtime contract this module re-exports.
export * from './agent-session-resume-runtime-capabilities'
import { AGENT_SESSION_BACKGROUND_TASK_CHILD_VIEWS_CAPABILITY } from './agent-session-background-task-child-views-capability'
import { AGENT_SESSION_STOP_RUNTIME_CAPABILITIES } from './agent-session-stop-capabilities'
import { AGENT_SESSION_CREATE_RUNTIME_CAPABILITIES } from './agent-session-create-capabilities'
import { REMOTE_SERVER_UPDATE_CAPABILITY } from './remote-server-update'
import { SKILL_RUNTIME_CAPABILITIES } from './skill-install-capability'
import {
  MANAGED_RUNTIME_INSTALL_RUNTIME_CAPABILITY,
  MANAGED_RUNTIME_REMOVE_RUNTIME_CAPABILITY
} from './managed-runtime-install'
import { REMOTE_SERVER_UPDATE_CAPABILITY } from './remote-server-update'
import { MOBILE_RELAY_RUNTIME_CAPABILITIES } from './mobile-desktop-relay-contract'
import { SKILL_RUNTIME_CAPABILITIES } from './skill-install-capability'
import { ACCOUNT_RUNTIME_CAPABILITIES } from './account-runtime-capabilities'
import * as agentLaunchCapabilities from './agent-launch-runtime-capability'
import {
  AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY,
  AGENT_SESSION_ATTACHMENTS_RUNTIME_CAPABILITY,
  AGENT_SESSION_BACKGROUND_TASK_ROW_STOP_CAPABILITY,
  AGENT_SESSION_BACKGROUND_TASK_STOP_CAPABILITY,
  AGENT_SESSION_BOUNDARY_RUNTIME_CAPABILITY,
  AGENT_SESSION_CONVERSATION_OUTLINE_RUNTIME_CAPABILITY,
  AGENT_SESSION_HOST_AUTHORITY_RUNTIME_CAPABILITY,
  AGENT_SESSION_KEYBOARD_RUNTIME_CAPABILITY,
  AGENT_SESSION_OMP_RESUME_PATH_RUNTIME_CAPABILITY,
  AGENT_SESSION_PENDING_SEND_RESULT_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_COMMANDS_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_MESSAGE_EDIT_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUESTION_ANSWERS_RUNTIME_CAPABILITY,
  AGENT_SESSION_REWIND_RECOVERY_CAPABILITY,
  AGENT_SESSION_REWIND_RUNTIME_CAPABILITY,
  AGENT_SESSION_SEND_ANSWERS_PROOF_RUNTIME_CAPABILITY,
  AGENT_SESSION_TURN_ITEM_CAPABILITY,
  AI_VAULT_RUNTIME_CAPABILITY,
  AI_VAULT_SESSION_TITLES_RUNTIME_CAPABILITY,
  ANTIGRAVITY_CONFIGURED_MODEL_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_AUTOMATION_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_FILE_CHANNEL_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_PAGE_METADATA_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_EXECUTION_HOSTS_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY,
  BROWSER_SCREENCAST_RUNTIME_CAPABILITY,
  BROWSER_TAB_CREATE_KNOWN_ID_RUNTIME_CAPABILITY,
  FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY,
  FOLDER_WORKSPACE_PATH_STATUS_RUNTIME_CAPABILITY,
  GITHUB_MARK_PR_READY_RUNTIME_CAPABILITY,
  GITLAB_READY_FOR_REVIEW_RUNTIME_CAPABILITY,
  LINEAR_ISSUE_ATTRIBUTE_FILTER_RUNTIME_CAPABILITY,
  NOTIFICATIONS_REMOTE_PUSH_RUNTIME_CAPABILITY,
  PREFLIGHT_OTHER_RUNTIME_REFUSAL_RUNTIME_CAPABILITY,
  PREFLIGHT_WORKSPACE_SCOPED_RUNTIME_CAPABILITY,
  PROJECT_HOST_SETUP_RUNTIME_CAPABILITY,
  REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY,
  REPO_SEARCH_QUALIFIED_REFS_RUNTIME_CAPABILITY,
  RUNTIME_AUTOMATIC_WORK_RUNTIME_CAPABILITY,
  RUNTIME_SOURCE_FENCE_RUNTIME_CAPABILITY,
  SESSION_TAB_CLOSE_INTENT_RUNTIME_CAPABILITY,
  SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  TASK_SOURCE_CONTEXT_RUNTIME_CAPABILITY,
  TERMINAL_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY,
  TERMINAL_CREATE_SHELL_SELECTION_RUNTIME_CAPABILITY,
  TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY,
  TERMINAL_PROMPT_DELIVERY_RUNTIME_CAPABILITY,
  TERMINAL_QUERY_REPLY_INPUT_RUNTIME_CAPABILITY,
  TERMINAL_SPAWN_INTENT_RUNTIME_CAPABILITY,
  WORKSPACE_PORTS_HOST_SCOPED_RUNTIME_CAPABILITY,
  WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY,
  WORKTREE_ARCHIVE_FAILURE_BLOCKING_RUNTIME_CAPABILITY,
  WORKTREE_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY,
  WORKTREE_GITHUB_PR_SUPPRESSION_RUNTIME_CAPABILITY,
  WORKTREE_LINKED_WORK_ITEM_CONTEXT_RUNTIME_CAPABILITY,
  WORKTREE_PROVISIONED_ROOT_RUNTIME_CAPABILITY,
  WORKTREE_VISIBILITY_DEFAULTS_RUNTIME_CAPABILITY,
  WORKTREE_VISIBILITY_SOURCE_DEFAULTS_RUNTIME_CAPABILITY
} from './runtime-capability-constants'

// Why: declares the Orca runtime RPC compatibility contract. Desktop,
// headless server, CLI, and mobile builds may drift in app version, but
// they must agree on this protocol range before runtime RPCs are allowed.
//
// Bump RUNTIME_PROTOCOL_VERSION when:
//   - You remove an RPC method or required parameter that clients use.
//   - You change the meaning (units, nullability) of an existing field
//     clients read.
//   - You change encrypted framing, terminal stream framing, or auth.
// Do NOT bump for:
//   - Adding new RPC methods.
//   - Adding new optional fields on existing methods.
//   - Adding new ignorable event types.
//
// Bump MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION when a runtime server must
// refuse older clients. Bump MIN_COMPATIBLE_RUNTIME_SERVER_VERSION when
// this client build requires a newer server. Exact app-version equality is
// never required; these numbers define the supported compatibility window.

export const RUNTIME_PROTOCOL_VERSION = 3
export const MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION = 2
export const MIN_COMPATIBLE_RUNTIME_SERVER_VERSION = 2

export const PROJECT_HOST_SETUP_RUNTIME_CAPABILITY = 'project-host-setup.v1' as const
export const TASK_SOURCE_CONTEXT_RUNTIME_CAPABILITY = 'task-source-context.v1' as const
export const WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY = 'workspace-run-context.v1' as const
export const WORKTREE_LINKED_WORK_ITEM_CONTEXT_RUNTIME_CAPABILITY =
  'worktree.linked-work-item-context.v1' as const
export const WORKTREE_GITHUB_PR_SUPPRESSION_RUNTIME_CAPABILITY =
  'worktree.github-pr-suppression.v1' as const
// Legacy clients cannot safely derive a branch name from a qualified ref selector.
export const REPO_SEARCH_QUALIFIED_REFS_RUNTIME_CAPABILITY =
  'repo.search-qualified-refs.v1' as const
export const REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY = 'remote-runtime.shared-control.v1' as const
export const AGENT_LAUNCH_OVERRIDES_RUNTIME_CAPABILITY = 'agent-launch-overrides.v1' as const
export const FOLDER_WORKSPACE_PATH_STATUS_RUNTIME_CAPABILITY =
  'folder-workspace.path-status.v1' as const
export const LINEAR_ISSUE_ATTRIBUTE_FILTER_RUNTIME_CAPABILITY =
  'linear.issue-attribute-filter.v1' as const
export const JIRA_USER_FIELDS_RUNTIME_CAPABILITY = 'jira.user-fields.v1' as const
export const JIRA_USER_FIELDS_UPDATE_REQUIRED_MESSAGE =
  'Creating Jira issues with user fields requires a newer Orca server. Update the server and try again.'
// Why: signals the host exposes the Agent Session History scanner over RPC
// (aiVault.listSessions). Registered unconditionally for every build, so it is a
// STATIC capability advertised by getStatus() automatically — NOT a runtime
// conditional like browser.headless.v1.
export const AI_VAULT_RUNTIME_CAPABILITY = 'aiVault.v1' as const
export const AI_VAULT_SESSION_TITLES_RUNTIME_CAPABILITY = 'aiVault.session-titles.v1' as const
// Why: signals a host owns browser pages with no renderer (headless serve via the
// offscreen backend). Advertised only when that backend is actually available, so
// clients never fall back to a local desktop browser tab for a remote-owned page.
export const BROWSER_HEADLESS_RUNTIME_CAPABILITY = 'browser.headless.v1' as const
export const BROWSER_IDENTITY_RUNTIME_CAPABILITY = 'browser.identity.v1' as const
// Why conditional: only a desktop runtime holds the SSH registry managed servers are run from.
export const MANAGED_SERVER_RUNTIME_CAPABILITY = 'managedServer.v1' as const
export const BROWSER_SCREENCAST_RUNTIME_CAPABILITY = 'browser.screencast.v1' as const
export const BROWSER_CERTIFICATE_TRUST_RUNTIME_CAPABILITY = 'browser.certificate-trust.v1' as const
// Why: older hosts discard browser.tabCreate's page field, so clients may only
// treat a preallocated page ID as canonical when this is advertised.
export const BROWSER_TAB_CREATE_KNOWN_ID_RUNTIME_CAPABILITY =
  'browser.tab-create-known-id.v1' as const
export const BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY = 'browser.clientHost.v1' as const
export const BROWSER_CLIENT_PAGE_METADATA_RUNTIME_CAPABILITY =
  'browser.clientHost.pageMetadata.v1' as const
export const BROWSER_CLIENT_AUTOMATION_RUNTIME_CAPABILITY =
  'browser.clientHost.automation.v1' as const
// Why: without it a client-placed browser.upload would resolve remote paths on the desktop filesystem, so uploads fail closed instead.
export const BROWSER_CLIENT_FILE_CHANNEL_RUNTIME_CAPABILITY =
  'browser.clientHost.fileChannel.v1' as const
export const BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY = 'network.browserTunnel.v1' as const
export const BROWSER_NETWORK_EXECUTION_HOSTS_RUNTIME_CAPABILITY =
  'network.browserTunnel.executionHosts.v1' as const
// Why: hosts without this strip terminal.send's inputKind (zod object drops
// unknown keys), so a mobile xterm query reply would land as ordinary
// floor-taking input. Mobile must not forward replies unless advertised.
export const TERMINAL_QUERY_REPLY_INPUT_RUNTIME_CAPABILITY =
  'terminal.query-reply-input.v1' as const
// Why: without this, prompt request IDs and waitSubmitMs are stripped and a retry would resend raw input.
export const TERMINAL_PROMPT_DELIVERY_RUNTIME_CAPABILITY = 'terminal.prompt-delivery.v1' as const
// Why: paired clients may unmount xterm only when the host can return a
// bounded, sequenced scrollback snapshot for lossless reveal.
export const TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY = 'terminal.paired-parking.v1' as const
// Why: older hosts lack the targeted settings RPCs and strip agentPrompt from
// terminal creation, so mobile must hide Quick Commands unless both are present.
export const TERMINAL_QUICK_COMMANDS_RUNTIME_CAPABILITY = 'terminal.quick-commands.v1' as const
// Why: older hosts strip worktree.create's clientMutationId, so mobile must only
// replay ambiguous cutovers when the host advertises idempotent create support;
// status.worktreeCreateIdempotency carries the optional host retention policy.
export const WORKTREE_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY =
  'worktree.create-idempotency.v1' as const
// Scope of the claim: a hook that RUNS and fails cannot delete the checkout. It does not promise
// the hook was found — an SSH host whose orca.yaml cannot be read answers "no hook" and the removal
// proceeds, because a failed read is indistinguishable from an absent file across the relay
// (#20196 tracks the provider contract that would separate them).
// Why (#19334): "accepts --run-hooks" and "refuses to delete when the archive hook fails" were
// indistinguishable from the outside — both take the flag and behave identically on success, so
// the only way to tell an unfixed host apart was to fail a hook and see whether the checkout
// survived. Lifecycle integrations keep teardown evidence inside the checkout and cannot risk
// that. Advertised unconditionally: every build carrying this constant has the gate.
export const WORKTREE_ARCHIVE_FAILURE_BLOCKING_RUNTIME_CAPABILITY =
  'worktree.archive-failure-blocking.v1' as const
export const CODEX_RESET_CREDIT_RUNTIME_CAPABILITY = 'accounts.codex-reset-credit.v1' as const
export const ACCOUNT_IMPORT_RUNTIME_CAPABILITY = 'accounts.import-host-credentials.v1' as const
// Why: `orca account add claude` signs in to an account folder the host creates first.
export const CLAUDE_SIGN_IN_RUNTIME_CAPABILITY = 'accounts.claude-sign-in.v1' as const
export const ANTIGRAVITY_ACCOUNTS_RUNTIME_CAPABILITY = 'accounts.antigravity-native.v1' as const
export const DATA_ACCOUNT_RUNTIME_CAPABILITY = 'accounts.managed-data-profiles.v1' as const
// Why: older hosts cannot reconcile terminal.create's mutation after losing the reply, so clients may only retry unknown outcomes when advertised.
export const TERMINAL_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY =
  'terminal.create-idempotency.v2' as const
// Why: an older host strips terminal.create's unknown `shell` and answers with a terminal running
// the host default shell. That reply is indistinguishable from success, so a client asking for a
// shell must refuse rather than create the wrong one.
export const TERMINAL_CREATE_SHELL_SELECTION_RUNTIME_CAPABILITY =
  'terminal.create-shell-selection.v1' as const
export const SESSION_TAB_CLOSE_INTENT_RUNTIME_CAPABILITY = 'session-tabs.close-intent.v1' as const
export const SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY =
  'session-tabs.authoritative-inventory.v1' as const
// Why: this proves both headed and runtime-owned host paths place after a complete split parent.
// Legacy host paths disagree, so clients without this capability defer placement to the snapshot.
export const SESSION_TABS_SPLIT_GROUP_PLACEMENT_RUNTIME_CAPABILITY =
  'session-tabs.split-group-placement.v1' as const
// Why: a client advertising this retains every terminal retirement proof it receives until the
// surface is published live again, so a session-tabs stream sends each proof once instead of
// repeating the host's whole bounded list on every title tick.
export const SESSION_TABS_RETIREMENT_PROOF_DELTA_RUNTIME_CAPABILITY =
  'session-tabs.retirement-proof-delta.v1' as const
export const AGENT_SESSION_BOUNDARY_RUNTIME_CAPABILITY =
  'agent-session.session-boundary.v1' as const
export { REMOTE_SERVER_UPDATE_CAPABILITY } from './remote-server-update'
export * from './agent-session-stop-capabilities'

// Native clients include the CLI, which cannot place Electron browser pages.
export const NATIVE_REMOTE_RUNTIME_CLIENT_CAPABILITIES = [
  SESSION_TAB_CLOSE_INTENT_RUNTIME_CAPABILITY,
  AGENT_SESSION_BOUNDARY_RUNTIME_CAPABILITY,
  WORKTREE_VISIBILITY_DEFAULTS_RUNTIME_CAPABILITY,
  WORKTREE_VISIBILITY_SOURCE_DEFAULTS_RUNTIME_CAPABILITY,
  WORKTREE_GITHUB_PR_SUPPRESSION_RUNTIME_CAPABILITY,
  REPO_SEARCH_QUALIFIED_REFS_RUNTIME_CAPABILITY,
  HEIMDALL_DISPATCH_RESULT_PRE_DISPATCH_FAILURE_RUNTIME_CAPABILITY,
  HEIMDALL_WATCHER_PARK_REASON_V2_RUNTIME_CAPABILITY,
  HEIMDALL_PARALLEL_EXECUTION_RUNTIME_CAPABILITY,
  ...AUTOMATION_RUNTIME_CLIENT_CAPABILITIES,
  agentLaunchCapabilities.AGENT_LAUNCH_RUNTIME_CAPABILITY
] as const

export const ANTIGRAVITY_CONFIGURED_MODEL_RUNTIME_CAPABILITY =
  'git.antigravity-configured-model.v1' as const

export const RUNTIME_CAPABILITIES = [
  AI_VAULT_CHAT_FORK_SOURCE_CAPABILITY,
  jiraDetailCapabilities.JIRA_TRANSITION_FIELDS_RUNTIME_CAPABILITY,
  JIRA_AGENT_ACCESS_RUNTIME_CAPABILITY,
  jiraDetailCapabilities.JIRA_CURRENT_SPRINT_RUNTIME_CAPABILITY,
  ...ORCAD_RUNTIME_CAPABILITIES,
  ...DEVICE_KEY_RUNTIME_CAPABILITIES,
  QODER_OWNED_TERMINAL_CREATE_CAPABILITY,
  ...AGENT_SESSION_STOP_RUNTIME_CAPABILITIES,
  ...AGENT_SESSION_CREATE_RUNTIME_CAPABILITIES,
  ANTIGRAVITY_CONFIGURED_MODEL_RUNTIME_CAPABILITY,
  'files.pathsExist',
  'ledger.v1',
  'runtime.status.compat.v1',
  'runtime.environments.v1',
  REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY,
  ...ORCHESTRATION_RUNTIME_CAPABILITIES,
  AGENT_LAUNCH_OVERRIDES_RUNTIME_CAPABILITY,
  BROWSER_SCREENCAST_RUNTIME_CAPABILITY,
  BROWSER_TAB_CREATE_KNOWN_ID_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_PAGE_METADATA_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_AUTOMATION_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_FILE_CHANNEL_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_EXECUTION_HOSTS_RUNTIME_CAPABILITY,
  'terminal.binary-stream.v1',
  'terminal.multiplex.v1',
  'workspace-ports.v1',
  'mobile.tasks.v1',
  PROJECT_HOST_SETUP_RUNTIME_CAPABILITY,
  TASK_SOURCE_CONTEXT_RUNTIME_CAPABILITY,
  WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY,
  WORKTREE_PROVISIONED_ROOT_RUNTIME_CAPABILITY,
  WORKTREE_LINKED_WORK_ITEM_CONTEXT_RUNTIME_CAPABILITY,
  ...WORKSPACE_ATTACHMENT_RUNTIME_CAPABILITIES,
  WORKTREE_GITHUB_PR_SUPPRESSION_RUNTIME_CAPABILITY,
  REPO_SEARCH_QUALIFIED_REFS_RUNTIME_CAPABILITY,
  FOLDER_WORKSPACE_PATH_STATUS_RUNTIME_CAPABILITY,
  LINEAR_ISSUE_ATTRIBUTE_FILTER_RUNTIME_CAPABILITY,
  ...jiraDetailCapabilities.JIRA_DETAIL_RUNTIME_CAPABILITIES,
  JIRA_SAVED_FILTER_RUNTIME_CAPABILITY,
  JIRA_STATUS_FILTER_RUNTIME_CAPABILITY,
  AI_VAULT_RUNTIME_CAPABILITY,
  AI_VAULT_SESSION_TITLES_RUNTIME_CAPABILITY,
  TERMINAL_QUERY_REPLY_INPUT_RUNTIME_CAPABILITY,
  TERMINAL_PROMPT_DELIVERY_RUNTIME_CAPABILITY,
  TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY,
  TERMINAL_SPAWN_INTENT_RUNTIME_CAPABILITY,
  RUNTIME_AUTOMATIC_WORK_RUNTIME_CAPABILITY,
  ...TERMINAL_QUICK_COMMAND_RUNTIME_CAPABILITIES,
  WORKTREE_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY,
  WORKTREE_ARCHIVE_FAILURE_BLOCKING_RUNTIME_CAPABILITY,
  TERMINAL_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY,
  TERMINAL_CREATE_SHELL_SELECTION_RUNTIME_CAPABILITY,
  SESSION_TAB_CLOSE_INTENT_RUNTIME_CAPABILITY,
  SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY,
  ...SESSION_TABS_RUNTIME_CAPABILITIES,
  AGENT_SESSION_BOUNDARY_RUNTIME_CAPABILITY,
  REMOTE_SERVER_UPDATE_CAPABILITY,
  MANAGED_RUNTIME_INSTALL_RUNTIME_CAPABILITY,
  MANAGED_RUNTIME_REMOVE_RUNTIME_CAPABILITY,
  AGENT_SESSION_HOST_AUTHORITY_RUNTIME_CAPABILITY,
  AGENT_SESSION_OMP_RESUME_PATH_RUNTIME_CAPABILITY,
  AGENT_SESSION_KEYBOARD_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  AGENT_SESSION_CURRENT_REQUESTS_CLIENT_CAPABILITY,
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY,
  AGENT_SESSION_PENDING_SEND_RESULT_RUNTIME_CAPABILITY,
  // The host side: it accepts a send before any agent has it, and a Stop with no writer before a
  // turn starts, so a client may gate on either.
  AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY,
  AGENT_SESSION_SEND_ANSWERS_PROOF_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_COMMANDS_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_MESSAGE_EDIT_RUNTIME_CAPABILITY,
  AGENT_SESSION_CONTINUE_INTERRUPTED_RUNTIME_CAPABILITY,
  AGENT_SESSION_PERMISSION_MODES_RUNTIME_CAPABILITY,
  ...STRUCTURED_AGENT_SESSION_SURFACE_RUNTIME_CAPABILITIES,
  ...AGENT_SESSION_ATTENTION_RUNTIME_CAPABILITIES,
  AGENT_SESSION_REWIND_RUNTIME_CAPABILITY,
  AGENT_SESSION_REWIND_RECOVERY_CAPABILITY,
  AGENT_SESSION_CONVERSATION_OUTLINE_RUNTIME_CAPABILITY,
  AGENT_SESSION_BACKGROUND_TASK_STOP_CAPABILITY,
  AGENT_SESSION_QUESTION_ANSWERS_RUNTIME_CAPABILITY,
  AGENT_SESSION_ATTACHMENTS_RUNTIME_CAPABILITY,
  AGENT_SESSION_TURN_ITEM_CAPABILITY,
  AGENT_SESSION_BACKGROUND_TASK_ROW_STOP_CAPABILITY,
  AGENT_SESSION_BACKGROUND_TASK_CHILD_VIEWS_CAPABILITY,
  ...AGENT_SESSION_RESUME_RUNTIME_CAPABILITIES,
  FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY,
  GITHUB_MARK_PR_READY_RUNTIME_CAPABILITY,
  GITLAB_READY_FOR_REVIEW_RUNTIME_CAPABILITY,
  WORKTREE_VISIBILITY_DEFAULTS_RUNTIME_CAPABILITY,
  WORKTREE_VISIBILITY_SOURCE_DEFAULTS_RUNTIME_CAPABILITY,
  ACCOUNT_IMPORT_RUNTIME_CAPABILITY,
  CLAUDE_SIGN_IN_RUNTIME_CAPABILITY,
  ANTIGRAVITY_ACCOUNTS_RUNTIME_CAPABILITY,
  DATA_ACCOUNT_RUNTIME_CAPABILITY,
  CODEX_RESET_CREDIT_RUNTIME_CAPABILITY,
  ...SKILL_RUNTIME_CAPABILITIES,
  ...AUTOMATION_RUNTIME_CAPABILITIES,
  HEIMDALL_COMMANDS_RUNTIME_CAPABILITY,
  HEIMDALL_WATCHER_DELETE_RUNTIME_CAPABILITY,
  HEIMDALL_WATCHER_ANSWER_ESCALATION_RUNTIME_CAPABILITY,
  HEIMDALL_DISPATCH_RESULT_PRE_DISPATCH_FAILURE_RUNTIME_CAPABILITY,
  HEIMDALL_WATCHER_PARK_REASON_V2_RUNTIME_CAPABILITY,
  HEIMDALL_ENROLL_OWNER_RUNTIME_CAPABILITY,
  HEIMDALL_PARALLEL_EXECUTION_RUNTIME_CAPABILITY,
  HEIMDALL_OBJECTIVE_ROLE_LAUNCH_RUNTIME_CAPABILITY,
  HEIMDALL_HOSTED_REVIEW_DERIVED_PAYLOAD_RUNTIME_CAPABILITY,
  HEIMDALL_HOSTED_REVIEW_CHECK_SCOPE_RUNTIME_CAPABILITY,
  HEIMDALL_OBJECTIVE_NEW_WORKTREE_RUNTIME_CAPABILITY,
  NOTIFICATIONS_REMOTE_PUSH_RUNTIME_CAPABILITY,
  ASK_REGISTRY_RUNTIME_CAPABILITY,
  ...AGENT_LAUNCH_RUNTIME_CAPABILITIES
] as const

export type RuntimeCapability = (typeof RUNTIME_CAPABILITIES)[number] | (string & {})

// COMPAT(mobileProtocolAliases): added 2026-05-15 for mobile builds that
// still read desktop/mobile names; remove once mobile reads runtime names.
export const DESKTOP_PROTOCOL_VERSION = RUNTIME_PROTOCOL_VERSION
export const MIN_COMPATIBLE_MOBILE_VERSION = MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
