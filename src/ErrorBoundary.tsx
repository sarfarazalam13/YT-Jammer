import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { failed: boolean; message: string | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false, message: null };

  static getDerivedStateFromError(error: Error): State {
    return { failed: true, message: error.message };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("YT Jam encountered an unrecoverable UI error.", error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return <main className="fatal-error" role="alert">
      <span>PLAYER RECOVERY</span>
      <h1>Something went out of tune.</h1>
      <p>Your room is still safe. Reload this device to reconnect to the latest shared playback state.</p>
      {this.state.message && <code>{this.state.message}</code>}
      <button type="button" onClick={() => window.location.reload()}>Reload YT Jam</button>
    </main>;
  }
}
