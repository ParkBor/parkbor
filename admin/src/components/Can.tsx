import type { ReactNode } from 'react'
import { useRole } from '../lib/auth'
import { type Action, can } from '../lib/rbac'

interface CanProps {
  action: Action
  children: ReactNode
  fallback?: ReactNode
}

/** Hides UI the role cannot use. A hint only: the backend rejects the request regardless. */
export function Can({ action, children, fallback = null }: CanProps) {
  return can(useRole(), action) ? <>{children}</> : <>{fallback}</>
}
