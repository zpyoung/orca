/**
 * The capability name every kind-specific owner intervention gates on. An enrollment that wants
 * the owner able to apply kind-specific interventions must turn this capability on or gated,
 * exactly like any other action capability — gate 5 ("capability modes") is `gateAction`'s existing
 * generic enforcement, not anything owner-specific.
 */
export const OWNER_INTERVENTION_CAPABILITY = 'owner-intervention'
