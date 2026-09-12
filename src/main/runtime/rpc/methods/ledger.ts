import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import type { LedgerRequest } from '../../../../shared/ledger'
import { verifyAndConsumeLedgerUiAttestation } from '../ledger-ui-attestation'

const ledgerRequestBaseSchema = z
  .object({
    operation: z.enum([
      'file',
      'list',
      'show',
      'edit',
      'state',
      'review',
      'revert',
      'import',
      'catalog',
      'approve',
      'bulk-state',
      'delete-entries',
      'delete-ledger',
      'attach',
      'settings',
      'removal-preview'
    ]),
    target: z
      .object({
        workspaceId: z.string().min(1).optional(),
        owner: z.object({ tier: z.enum(['project', 'group']), id: z.string().min(1) }).optional(),
        ledgerId: z.string().min(1).optional(),
        group: z.boolean().optional(),
        groupSelector: z.string().min(1).optional()
      })
      .strict()
      .optional(),
    type: z.enum(['bug', 'deferred', 'test-gap', 'proposal', 'decision']).optional(),
    content: z.record(z.string(), z.unknown()).optional(),
    id: z.string().min(1).optional(),
    ifRevision: z.number().int().nonnegative().optional(),
    toRevision: z.number().int().nonnegative().optional(),
    state: z.enum(['open', 'resolved', 'archived']).optional(),
    filters: z
      .object({
        type: z.enum(['bug', 'deferred', 'test-gap', 'proposal', 'decision']).optional(),
        state: z.enum(['open', 'resolved', 'archived']).optional(),
        reviewed: z.boolean().optional(),
        stale: z.boolean().optional(),
        workspaceId: z.string().min(1).optional(),
        branch: z.string().optional()
      })
      .strict()
      .optional(),
    selections: z
      .array(z.object({ id: z.string().min(1), revision: z.number().int().nonnegative() }).strict())
      .max(10_000)
      .optional(),
    ifLedgerRevision: z.number().int().nonnegative().optional(),
    attachTo: z
      .object({ tier: z.enum(['project', 'group']), id: z.string().min(1) })
      .strict()
      .optional(),
    confirmed: z.boolean().optional(),
    staleAfterDays: z.number().int().nonnegative().max(3650).optional(),
    removal: z
      .object({
        repoId: z.string().min(1).optional(),
        projectGroupId: z.string().min(1).optional(),
        repoIds: z.array(z.string().min(1)).max(10_000).optional(),
        removeContainedProjects: z.boolean().optional(),
        expectedLedgers: z
          .array(
            z
              .object({
                ledgerId: z.string().min(1).max(256),
                revision: z.number().int().safe().positive()
              })
              .strict()
          )
          .max(10_000)
          .optional()
      })
      .strict()
      .optional()
  })
  .strict()

const ledgerRequestSchema: z.ZodType<LedgerRequest> = ledgerRequestBaseSchema.superRefine(
  (request, ctx) => {
    if (['approve', 'delete-entries', 'delete-ledger', 'attach'].includes(request.operation)) {
      ctx.addIssue({
        code: 'custom',
        path: ['operation'],
        message: 'Operation requires the trusted ledger UI path'
      })
    }
  }
) as z.ZodType<LedgerRequest>

export const LEDGER_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'ledger.request',
    params: z.object({ request: ledgerRequestSchema }).strict(),
    handler: (params, { runtime, orchestrationCompatibilityEvidence }) =>
      runtime.executeLedgerRequest(params.request, orchestrationCompatibilityEvidence)
  }),
  defineMethod({
    name: 'ledger.ui',
    params: z
      .object({
        request: ledgerRequestBaseSchema,
        attestation: z
          .object({
            timestamp: z.number().int().safe(),
            nonce: z.string().min(1).max(256),
            mac: z.string().min(1).max(256)
          })
          .strict()
      })
      .strict(),
    handler: (params, { runtime, authenticatedCredential }) => {
      verifyAndConsumeLedgerUiAttestation(
        params.request,
        params.attestation,
        authenticatedCredential
      )
      return runtime.executeLedgerUiRequest(params.request)
    }
  })
]
