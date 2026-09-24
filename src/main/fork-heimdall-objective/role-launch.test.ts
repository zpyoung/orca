import { describe, expect, it } from 'vitest'
import { resolveObjectiveRoleLaunch } from './role-launch'

describe('resolveObjectiveRoleLaunch', () => {
  it('omits model and effort when the role has no launch override', () => {
    expect(resolveObjectiveRoleLaunch({}, 'planner')).toEqual({})
    expect(resolveObjectiveRoleLaunch({ roleLaunch: {} }, 'planner')).toEqual({})
  })

  it('passes model and effort through when set for the dispatched role', () => {
    expect(
      resolveObjectiveRoleLaunch(
        { roleLaunch: { planner: { model: 'opus', effort: 'high' } } },
        'planner'
      )
    ).toEqual({ model: 'opus', effort: 'high' })
  })

  it('passes only the field that is set, and ignores overrides for other roles', () => {
    const roleLaunch = { planner: { model: 'opus' }, reviewer: { effort: 'low' as const } }
    expect(resolveObjectiveRoleLaunch({ roleLaunch }, 'planner')).toEqual({ model: 'opus' })
    expect(resolveObjectiveRoleLaunch({ roleLaunch }, 'implementer')).toEqual({})
  })

  it('covers both plan review and acceptance review through the reviewer role', () => {
    expect(
      resolveObjectiveRoleLaunch({ roleLaunch: { reviewer: { effort: 'max' } } }, 'reviewer')
    ).toEqual({ effort: 'max' })
  })
})
