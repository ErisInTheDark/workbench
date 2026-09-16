/* Exports: default ThreadRenderLabBoundary isolates fixture render failures until the next apply. */
"use client";
import { Component, type ErrorInfo, type ReactNode } from "react";

export default class ThreadRenderLabBoundary extends Component<{ children: ReactNode; revision: number }, { error: string | null; revision: number }> {
  state = { error: null as string | null, revision: this.props.revision };
  static getDerivedStateFromProps(props: { revision: number }, state: { revision: number }) {
    return props.revision === state.revision ? null : { error: null, revision: props.revision };
  }
  static getDerivedStateFromError(error: Error) {
    return { error: error.message.slice(0, 500) };
  }
  componentDidCatch(_error: Error, _info: ErrorInfo) {
    console.warn("Thread render lab fixture failed to render. See the preview error.");
  }
  render() {
    return this.state.error
      ? <p role="alert" className="p-4 text-danger">Fixture render failed: {this.state.error} Correct the input and apply again.</p>
      : this.props.children;
  }
}
