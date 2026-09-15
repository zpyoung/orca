import { useEffect, useState } from 'react'
import type { AgentFamily } from '../../../../../shared/review/agent-family'
import type { ReviewDepth, ReviewProfile } from '../../../../../shared/review/stage-schemas'
import type { TuiAgent } from '../../../../../shared/types'
import type { ReviewLaunchRequest, ReviewLaunchTargetKind } from './adversarial-review-model'

type LaunchDefaults = {
  targetKind: ReviewLaunchTargetKind
  target: string
  profile: ReviewProfile
  depth: ReviewDepth
  authorFamily: AgentFamily
  reviewer: TuiAgent | null
}

export function useAdversarialReviewLaunchState(open: boolean, defaults: LaunchDefaults) {
  const [targetKind, setTargetKind] = useState(defaults.targetKind)
  const [target, setTarget] = useState(defaults.target)
  const [criteria, setCriteria] = useState('')
  const [profile, setProfile] = useState(defaults.profile)
  const [depth, setDepth] = useState(defaults.depth)
  const [authorFamily, setAuthorFamily] = useState(defaults.authorFamily)
  const [reviewer, setReviewer] = useState<TuiAgent | null>(defaults.reviewer)

  useEffect(() => {
    if (!open) {
      return
    }
    setTargetKind(defaults.targetKind)
    setTarget(defaults.target)
    setCriteria('')
    setProfile(defaults.profile)
    setDepth(defaults.depth)
    setAuthorFamily(defaults.authorFamily)
    setReviewer(defaults.reviewer)
  }, [defaults, open])

  const request: ReviewLaunchRequest = {
    targetKind,
    target,
    criteria,
    profile,
    depth,
    authorFamily,
    reviewer
  }
  return {
    request,
    setTargetKind,
    setTarget,
    setCriteria,
    setProfile,
    setDepth,
    setAuthorFamily,
    setReviewer
  }
}
