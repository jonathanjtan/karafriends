import React from "react";

import * as styles from "./Loader.module.scss";

interface Props {
  children: React.ReactNode;
  // When any of these change, a currently-displayed error is cleared and the
  // children remount (so e.g. typing a new search term recovers instead of
  // staying stuck on the previous failure). react-error-boundary's pattern.
  resetKeys?: ReadonlyArray<unknown>;
}

interface State {
  error: Error | null;
}

function resetKeysChanged(
  a: ReadonlyArray<unknown> = [],
  b: ReadonlyArray<unknown> = [],
): boolean {
  return a.length !== b.length || a.some((value, i) => value !== b[i]);
}

// Catches errors thrown while rendering lazy-loaded Relay queries (a rejected
// `useLazyLoadQuery` re-throws after Suspense resolves) and renders an inline
// message instead of letting the throw unmount all of `<App>`, which used to
// whitescreen the whole remocon on any failed search or unreachable service.
class QueryErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prevProps: Props) {
    if (
      this.state.error !== null &&
      resetKeysChanged(prevProps.resetKeys, this.props.resetKeys)
    ) {
      this.reset();
    }
  }

  private reset = () => this.setState({ error: null });

  render() {
    if (this.state.error !== null) {
      return (
        <div className={styles.queryError}>
          <p>
            Couldn&apos;t load that. The karaoke service may be unreachable.
          </p>
          <button className={styles.retryButton} onClick={this.reset}>
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default QueryErrorBoundary;
