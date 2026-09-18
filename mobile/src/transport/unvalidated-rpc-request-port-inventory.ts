/**
 * Every file that still reaches mobile's raw RPC request port, held as data.
 *
 * A reference is any direct reach for the port: a `.sendRequest` access or declaration, a
 * `'sendRequest'` selector such as `Pick<RpcClient, 'sendRequest'>`, a call to the coalescing
 * second sender `sendSingleFlightRequest`, or an import of unvalidated-rpc-request-port.ts.
 * The count is per file and is a ceiling, not a target: unvalidated-rpc-request-port-boundary.test.ts
 * fails on a file that is not listed, on a listed file that no longer reaches the port, and on a
 * listed file whose count went up. Both lists only shrink.
 *
 * The owners are permanent — they implement, route or validate the port. The pending list is the
 * step-4 migration backlog and shares one reason, stated once here instead of 144 times:
 * the call site predates the typed contract and still picks its own method string, its own
 * acceptance rule and its own decoding. Replacing one with an RpcOperation deletes its line.
 *
 * Where a group below names a blocker, it is a recording blocker, not a migration blocker.
 * Pointing a site at an operation is mechanical; the golden recorded against the old code before
 * the refactor is the only parity proof this migration has. So a site the recorder cannot mount
 * cannot be recorded, and unrecorded sites do not migrate.
 */
export type UnvalidatedRpcRequestPortEntry = {
  readonly file: string
  readonly references: number
}

/** Modules whose job is the port. These do not shrink to zero. */
export const UNVALIDATED_RPC_REQUEST_PORT_OWNERS: readonly UnvalidatedRpcRequestPortEntry[] = [
  // Implements the port over the device-to-host websocket.
  { file: 'src/transport/direct-rpc-client.ts', references: 3 },
  // Fakes the port for the supervisor suites; a non-test file only because tsconfig excludes tests.
  { file: 'src/transport/mobile-endpoint-supervisor-test-fakes.ts', references: 2 },
  // Implements the port over a relay channel.
  { file: 'src/transport/mobile-relay-physical-client.ts', references: 2 },
  // Supplies the port for one relay session.
  { file: 'src/transport/mobile-relay-rpc-session.ts', references: 1 },
  // A second raw sender: string method in, unread envelope out. Its callers are fenced too.
  { file: 'src/transport/request-single-flight.ts', references: 3 },
  // Owns connect-wait, timeout and replay bookkeeping for every raw request.
  { file: 'src/transport/rpc-client-request-tracker.ts', references: 1 },
  // Composes the port into RpcClient, which is why every holder of a client still carries it.
  { file: 'src/transport/rpc-client.ts', references: 2 },
  // The typed boundary itself — the one module that turns a reply into a declared type.
  { file: 'src/transport/rpc-operation.ts', references: 5 },
  // Forwards the port across a physical-client cutover.
  { file: 'src/transport/stable-logical-rpc-client.ts', references: 2 },
  // Names the port as the recording oracle's sender contract; a non-test file for the same reason.
  { file: 'src/test-support/rpc-recording/recording-scenario.ts', references: 1 },
  // Scripts the port for the recording oracle, over the real tracker and logical client.
  { file: 'src/test-support/rpc-recording/scripted-rpc-transport.ts', references: 5 }
]

/** Call sites awaiting migration to a typed operation. Grouped by the feature area that owns them. */
export const UNVALIDATED_RPC_REQUEST_PORT_PENDING: readonly UnvalidatedRpcRequestPortEntry[] = [
  // app/h/[hostId]/ — Expo route screens
  // Holdout behind two gates. The first is the mount: the screen reads
  // `expo-router.useFocusEffect` and `react-native.ScrollView`, neither is a substituted member, so
  // the trap refuses before any effect runs. Substituting exactly those two clears it and exposes
  // the second gate — the mount effect that opens `accounts.subscribe`, which the request-only
  // runner refuses, leaving `status.get` as the only send and taking the tree with it. So the
  // refresh control and the account rows carrying `accounts.list` and the three `accounts.select*`
  // methods never exist to be driven. Subscriptions are a later step, and the two members are left
  // out here because the engine gains `useFocusEffect` on its own track.
  { file: 'app/h/[hostId]/accounts.tsx', references: 2 },

  // app/ — Expo route screens
  // Holdout: not the screen. It renders to completion under inert reanimated and gesture-handler
  // substitutes, and then sends nothing: its host list comes from `loadHosts()`, which joins a
  // device token held in the keychain through expo-secure-store. A scenario can declare the async
  // store and the notification tray, not a credential, so `loadHosts()` answers with an empty list
  // and the screen has no client. `notifications.testPush` migrated because its screen reads
  // `loadHostCatalog()`, which keeps a credential-less entry. Line ~193 also reads `ms` off the
  // reply envelope instead of off its result, so the value is always undefined; that is a product
  // defect with its own fix and re-record, not something this migration may quietly repair.
  { file: 'app/terminal-settings.tsx', references: 3 },

  // src/agent-history/ — agent history loads
  { file: 'src/agent-history/MobileAgentSessionHistoryPanel.tsx', references: 6 },
  { file: 'src/agent-history/use-mobile-agent-history-state.ts', references: 2 },

  // src/browser/ — hosted browser control
  { file: 'src/browser/use-mobile-browser-commands.ts', references: 5 },
  { file: 'src/browser/use-mobile-browser-request.ts', references: 1 },

  // src/components/ — shared widgets that fetch their own data
  { file: 'src/components/codex-reset-credit-capability.ts', references: 2 },
  { file: 'src/components/codex-reset-credit.ts', references: 3 },
  { file: 'src/components/use-new-workspace-execution-target.ts', references: 4 },
  { file: 'src/components/use-new-workspace-repositories.ts', references: 1 },
  { file: 'src/components/use-new-workspace-runtime-context.ts', references: 3 },
  { file: 'src/components/use-new-workspace-setup-script.ts', references: 1 },

  // src/dictation/ — dictation session control
  { file: 'src/dictation/mobile-dictation-setup.ts', references: 10 },

  // src/files/ — file read, write and preview
  { file: 'src/files/mobile-file-mutation-ownership.ts', references: 3 },
  { file: 'src/files/mobile-file-preview-request.ts', references: 6 },
  { file: 'src/files/mobile-file-tab-doc.ts', references: 4 },
  { file: 'src/files/mobile-terminal-artifact-grant-refresh.ts', references: 2 },
  { file: 'src/files/MobileFileExplorerPanel.tsx', references: 2 },

  // src/home/ — home screen host reads
  { file: 'src/home/mobile-home-host-requests.ts', references: 5 },

  // src/hooks/ — cross-screen data hooks
  { file: 'src/hooks/mobile-dictation-audio-chunk.ts', references: 1 },
  { file: 'src/hooks/mobile-dictation-desktop-start.ts', references: 4 },
  { file: 'src/hooks/use-mobile-dictation.ts', references: 4 },

  // src/host-screen/ — host screen catalog and actions
  { file: 'src/host-screen/host-screen-overlays.tsx', references: 1 },
  { file: 'src/host-screen/use-host-repo-metadata.ts', references: 1 },
  { file: 'src/host-screen/use-host-view-settings.ts', references: 2 },
  { file: 'src/host-screen/use-host-worktree-actions.ts', references: 3 },

  // src/notifications/ — push registration and delivery. Nothing is left here. Registration and
  // unregistration migrated in step 4; see mobile-push-registration-operations.ts. Tray
  // reconciliation followed once a scenario could declare the notification tray and the stored host
  // list it resolves against; see push-dismissal-operations.ts. The stream unsubscribe inside the
  // `notifications.subscribe` callback migrated in step 6 once the recorder could script the
  // `ready` frame that hands it a subscription id; see desktop-notification-stream-operations.ts.

  // src/session/ — session screen: chat, diff review, PR actions, tabs
  { file: 'src/session/ai-vault-resume-launch.ts', references: 3 },
  { file: 'src/session/ai-vault-resume-preparation.ts', references: 2 },
  { file: 'src/session/github-pr-mutations.ts', references: 16 },
  { file: 'src/session/github-pr-rpc.ts', references: 9 },
  { file: 'src/session/mobile-clipboard-image.ts', references: 7 },
  { file: 'src/session/mobile-diff-review-loaders.ts', references: 5 },
  { file: 'src/session/mobile-file-tap-open.ts', references: 3 },
  { file: 'src/session/mobile-image-attachment.ts', references: 2 },
  { file: 'src/session/mobile-native-chat-image-attachment.ts', references: 1 },
  { file: 'src/session/mobile-native-chat-image-send.ts', references: 2 },
  { file: 'src/session/mobile-native-chat-send.ts', references: 2 },
  { file: 'src/session/mobile-native-chat-session-option-persistence.ts', references: 1 },
  { file: 'src/session/mobile-native-chat-stale-input.ts', references: 1 },
  { file: 'src/session/mobile-new-tab-agent-loader.ts', references: 4 },
  { file: 'src/session/mobile-session-tab-activation.ts', references: 3 },
  { file: 'src/session/mobile-session-tabs-stream-health.ts', references: 1 },
  { file: 'src/session/mobile-structured-agent-session-launch.ts', references: 3 },
  { file: 'src/session/mobile-structured-agent-session-rpc.ts', references: 1 },
  // Holdout: unrecorded site, record-first rule. The startup effect drives 36 members of the
  // session model including the terminal subscription lifecycle, which is a later step.
  { file: 'src/session/use-mobile-session-startup.ts', references: 2 },
  // Holdout: unrecorded site, record-first rule. The create path subscribes to the terminal it
  // makes, and the request-only runner refuses the subscription.
  { file: 'src/session/use-mobile-session-terminal-create-actions.ts', references: 2 },
  // Holdout: unrecorded site, record-first rule. The display-mode write is gated on an open
  // terminal subscription, which is a later step.
  { file: 'src/session/use-mobile-session-terminal-stream-display.ts', references: 1 },
  { file: 'src/session/use-mobile-terminal-paste.ts', references: 1 },
  { file: 'src/session/use-quick-commands.ts', references: 2 },

  // src/settings/ — settings screen actions
  { file: 'src/settings/native-voice-settings-operations.ts', references: 1 },

  // src/settings/ — notification display probe
  { file: 'src/settings/notification-display-test.tsx', references: 1 },

  // src/source-control/ — one dynamic dispatcher left; the other 13 files migrated in step 4.
  // Its single reference multiplexes git.commit, git.status, git.upstreamStatus, git.fetch,
  // git.pull, git.push and every `{ method, params }` action step five other hooks hand it, so
  // it cannot drop below one until that step model is typed. See mobile-git-read-operations.ts
  // and mobile-git-mutation-operations.ts for the operations the rest of the domain now sends.
  { file: 'src/source-control/use-mobile-git-requests.ts', references: 1 },

  // src/tasks/ — task lists, filters and mutations. The workspace-creation half migrated in
  // step 4: create, hosted-base resolution, SSH/agent preflight, sparse presets, the Smart
  // source picker's provider reads and the screen's own preference writes. See
  // mobile-workspace-create-operations.ts, mobile-workspace-source-operations.ts,
  // mobile-task-runtime-operations.ts and mobile-task-source-search-operations.ts. What is left
  // is the provider item/detail/mutation half, plus two files that cannot reach zero:
  // mobile-tasks-source-family.test-support.ts matches the literal in a source scanner rather
  // than sending anything, and use-mobile-tasks-project-file-merge-actions.tsx and
  // use-mobile-tasks-hosted-metadata-actions.tsx each multiplex a `{ method, params }` step the
  // pickers hand them at runtime.
  { file: 'src/tasks/mobile-tasks-filter-pickers.tsx', references: 1 },
  { file: 'src/tasks/mobile-tasks-source-family.test-support.ts', references: 1 },
  { file: 'src/tasks/use-mobile-tasks-github-check-file-actions.tsx', references: 5 },
  { file: 'src/tasks/use-mobile-tasks-github-reply-merge-actions.tsx', references: 5 },
  { file: 'src/tasks/use-mobile-tasks-gitlab-github-status-actions.tsx', references: 3 },
  { file: 'src/tasks/use-mobile-tasks-hosted-comment-review-actions.tsx', references: 4 },
  { file: 'src/tasks/use-mobile-tasks-hosted-metadata-actions.tsx', references: 2 },
  { file: 'src/tasks/use-mobile-tasks-item-detail-loading.tsx', references: 4 },
  { file: 'src/tasks/use-mobile-tasks-item-detail-metadata-effects.tsx', references: 2 },
  { file: 'src/tasks/use-mobile-tasks-linear-item-actions.tsx', references: 3 },
  { file: 'src/tasks/use-mobile-tasks-list-and-detail-effects.tsx', references: 2 },
  { file: 'src/tasks/use-mobile-tasks-project-detail-loading.tsx', references: 1 },
  { file: 'src/tasks/use-mobile-tasks-project-file-merge-actions.tsx', references: 4 },
  { file: 'src/tasks/use-mobile-tasks-project-loading-actions.tsx', references: 4 },
  { file: 'src/tasks/use-mobile-tasks-project-metadata-actions.tsx', references: 3 },
  { file: 'src/tasks/use-mobile-tasks-project-metadata-loading.tsx', references: 3 },
  { file: 'src/tasks/use-mobile-tasks-project-repository-resolution.tsx', references: 1 },
  { file: 'src/tasks/use-mobile-tasks-project-review-check-actions.tsx', references: 4 },
  { file: 'src/tasks/use-mobile-tasks-project-thread-reply-actions.tsx', references: 4 },
  { file: 'src/tasks/use-mobile-tasks-project-workspace-comment-actions.tsx', references: 3 },
  { file: 'src/tasks/use-mobile-tasks-provider-load-actions.tsx', references: 5 },
  { file: 'src/tasks/use-mobile-tasks-route-and-item-state.tsx', references: 1 },
  { file: 'src/tasks/use-mobile-tasks-task-create-actions.tsx', references: 3 },
  { file: 'src/tasks/use-mobile-tasks-task-list-loading.tsx', references: 4 },
  { file: 'src/tasks/use-mobile-tasks-task-pagination-actions.tsx', references: 1 },

  // src/transport/ — what is left of pairing, probing and capability reads after step 4. The
  // protocol gate, the retrying capability probe, the candidate race, credential rotation, the
  // direct-to-relay upgrade, startup pairing recovery and first pairing all send through
  // host-status-probe-operations.ts and mobile-relay-pairing-operations.ts now. Neither file below
  // shares the pending list's stated reason, so each carries its own:
  //
  // Decorates one PairingCandidateClient with director recovery, forwarding whatever method it is
  // handed. It IS the port for the candidate it wraps, so it cannot send through an operation; the
  // one method string it did choose now comes from hostStatusProbe.
  { file: 'src/transport/pairing-relay-candidate.ts', references: 4 },
  // Its sender is the two physical clients' authenticated-but-not-yet-`connected` path, which is
  // not an RpcClient and is unreachable from the recording oracle, so a migration here could not
  // be shown to preserve behaviour. Its method and params are already shared constants.
  { file: 'src/transport/mobile-runtime-capability-negotiation.ts', references: 2 },
  // Sends through hostStatusProbe; the one reference left is its parameter type. Its callers do
  // not share a client type — push-registration.ts holds only the sender — so the parameter names
  // the port itself. It reaches zero when the last such caller migrates.
  { file: 'src/transport/runtime-capability-probe.ts', references: 1 }
]
