// ErrorBoundary — catches render-time throws in the React tree so a malformed result (or any UI
// bug) shows a message instead of silently tearing down the renderer. @opentui/react ships an
// ErrorBoundary but doesn't export it, so we keep a minimal local one.

import { Component } from "react";
import type { ReactNode } from "react";
import { C } from "./theme";

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <box flexDirection="column" padding={1} backgroundColor={C.bg}>
          <text fg={C.bad}>chord crashed: {this.state.error.message}</text>
          <text fg={C.dim}>press Ctrl+C to quit</text>
        </box>
      );
    }
    return this.props.children;
  }
}
