// Deliberately non-default values: a sample equal to the default would let a field leak
// through the pairing seam without failing the seam tests that consume this.
export const WORKSPACE_ACTIVITY_PAIRING_LOCAL_SAMPLES = {
  workspaceActivityWindow: 'week',
  workspaceActivityCustomDays: 14
} as const
