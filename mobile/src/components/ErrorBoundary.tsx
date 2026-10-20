import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  /** What to show instead of the crashed subtree; `reset` renders the children again. */
  fallback: (reset: () => void) => ReactNode;
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

/**
 * Keeps a crash in one area (the native map, say) from taking the whole app down. React only supports
 * error boundaries as classes. Nothing from the error is shown or logged here: messages can carry data.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // intentionally empty: crash reporting (Sentry) hooks in here once it is wired
  }

  private reset = (): void => this.setState({ hasError: false });

  render(): ReactNode {
    return this.state.hasError ? this.props.fallback(this.reset) : this.props.children;
  }
}
