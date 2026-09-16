export function shortObjectiveIdentity(value: string): string {
  return value.length > 12 ? `${value.slice(0, 12)}…` : value
}
