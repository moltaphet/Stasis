"use client";

import { Component, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

interface Props {
  children: ReactNode;
  label?: string;
}
interface State {
  hasError: boolean;
  message: string;
}

// Lightweight error boundary. If a descendant throws during render, in a
// lifecycle, or from an effect that bubbles a render error (e.g. an RPC fetch or
// EIP-6963 provider blinking), the error is contained here and a graceful fallback
// card is shown instead of white-screening the whole Next.js tree.
export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, message: "" };
  }

  static getDerivedStateFromError(error: unknown): State {
    return {
      hasError: true,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  componentDidCatch(error: unknown) {
    // Log for diagnostics; never rethrow.
    console.error("[stasis] error boundary contained:", error);
  }

  private reset = () => this.setState({ hasError: false, message: "" });

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div className="glass mx-auto my-6 max-w-2xl rounded-2xl border border-amber/30 p-6">
        <div className="flex items-center gap-2 text-amber">
          <AlertTriangle className="h-5 w-5" />
          <span className="text-sm font-semibold">
            {this.props.label ?? "Panel unavailable"}
          </span>
        </div>
        <p className="mt-2 text-sm text-zinc-400">
          A runtime error was contained here so the rest of the dashboard keeps
          running. This is usually a transient RPC or wallet-provider blip.
        </p>
        {this.state.message && (
          <p className="tnum mt-2 break-words font-mono text-xs text-zinc-600">
            {this.state.message.slice(0, 200)}
          </p>
        )}
        <button
          onClick={this.reset}
          className="mt-4 rounded-lg border border-white/15 bg-white/5 px-4 py-2 text-sm font-semibold text-zinc-200 transition-colors hover:border-mint/40 hover:text-white"
        >
          Try again
        </button>
      </div>
    );
  }
}
