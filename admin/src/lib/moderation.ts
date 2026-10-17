import type { LotStatus } from '@habi/api-client'

export type ModerationAction = 'approve' | 'suspend' | 'restore'

export function moderationActionsFor(status: LotStatus): ModerationAction[] {
  if (status === 'PENDING_REVIEW') return ['approve', 'suspend']
  if (status === 'ACTIVE') return ['suspend']
  return ['restore']
}
