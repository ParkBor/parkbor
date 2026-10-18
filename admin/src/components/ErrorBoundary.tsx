import { Button, Result, Space } from 'antd'
import { Component, type ErrorInfo, type ReactNode } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'

interface ErrorBoundaryProps {
  children: ReactNode
  /** Changing this value (e.g. the route) clears a previous error. */
  resetKey?: string
}

interface BoundaryProps extends ErrorBoundaryProps {
  t: TFunction
}

interface ErrorBoundaryState {
  error: Error | null
  resetKey?: string
}

const CHUNK_ERROR = /(Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Loading chunk [\w-]+ failed|ChunkLoadError)/i

/** A lazy chunk that no longer exists (new deploy) or could not be fetched. */
export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.name === 'ChunkLoadError' || CHUNK_ERROR.test(error.message)
}

class Boundary extends Component<BoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, resetKey: this.props.resetKey }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error }
  }

  static getDerivedStateFromProps(
    props: BoundaryProps,
    state: ErrorBoundaryState,
  ): Partial<ErrorBoundaryState> | null {
    return props.resetKey !== state.resetKey ? { error: null, resetKey: props.resetKey } : null
  }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // The screen below explains the failure; details stay out of the UI.
  }

  render(): ReactNode {
    const { error } = this.state
    const { t, children } = this.props
    if (error === null) return children
    const chunk = isChunkLoadError(error)
    return (
      <Result
        status="error"
        title={t(chunk ? 'boundary.chunkTitle' : 'boundary.title')}
        subTitle={t(chunk ? 'boundary.chunkDescription' : 'boundary.description')}
        extra={
          <Space>
            {chunk ? null : (
              <Button onClick={() => this.setState({ error: null })}>{t('common.retry')}</Button>
            )}
            <Button type="primary" onClick={() => window.location.reload()}>
              {t('boundary.reload')}
            </Button>
          </Space>
        }
      />
    )
  }
}

/** Catches render errors and failed lazy chunks below it; offers retry or a page reload. */
export function ErrorBoundary({ children, resetKey }: ErrorBoundaryProps) {
  const { t } = useTranslation()
  return (
    <Boundary t={t} resetKey={resetKey}>
      {children}
    </Boundary>
  )
}
