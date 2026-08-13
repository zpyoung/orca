import { z } from 'zod'
import { ResolveTargetKindSchema } from './stage-schemas'

export const CAPTURE_HASH_INPUTS = ['diff-text', 'raw-bytes', 'tree-walk'] as const
export const CaptureHashInputsSchema = z.enum(CAPTURE_HASH_INPUTS)
export type CaptureHashInputs = z.infer<typeof CaptureHashInputsSchema>

/**
 * `capture.json` — the staleness baseline a later re-hash is compared
 * against (tech.md § Verdict staleness). `baseline_oid`/`head_oid`/
 * `provider_ref` are null for target kinds with no such identity (a bare
 * path or worktree diff has no OID or hosted-provider reference).
 */
export const CaptureManifestSchema = z.object({
  target_kind: ResolveTargetKindSchema,
  scope: z.string(),
  baseline_oid: z.string().nullable(),
  head_oid: z.string().nullable(),
  provider_ref: z.string().nullable(),
  diff_file: z.string().nullable(),
  untracked_paths: z.array(z.string()),
  file_modes: z.literal('recorded-in-diff'),
  symlinks: z.literal('recorded-not-followed'),
  exclusions: z.array(z.string()),
  generated_outputs: z.array(z.string()),
  hash: z.string().min(1),
  hash_inputs: CaptureHashInputsSchema,
  hashed_at: z.string().min(1)
})
export type CaptureManifest = z.infer<typeof CaptureManifestSchema>
