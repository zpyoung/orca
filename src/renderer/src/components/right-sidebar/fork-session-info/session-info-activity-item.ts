import { Info } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { ActivityBarItem } from '../activity-bar-buttons'

/** Build the always-visible Session Info activity item. */
export function getSessionInfoActivityItem(): ActivityBarItem {
  return {
    id: 'session-info',
    icon: Info,
    title: translate('fork.sessionInfo.title', 'Session Info'),
    shortcut: ''
  }
}
