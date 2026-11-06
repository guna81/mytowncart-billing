// SPDX-License-Identifier: Apache-2.0
import React, { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error("ErrorBoundary caught an error:", error, errorInfo);
  }

  override render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }
      return (
        <div className="p-6 m-4 max-w-xl mx-auto rounded-xl border border-red-200 bg-red-50 text-red-900 shadow-sm">
          <h2 className="text-lg font-bold">An unexpected error occurred</h2>
          <p className="text-sm mt-1 text-red-700 font-mono break-words">
            {this.state.error?.message || "Unknown error"}
          </p>
          <div className="mt-4 flex gap-3">
            <button
              type="button"
              onClick={() => {
                this.setState({ hasError: false, error: null });
                window.location.reload();
              }}
              className="px-4 py-2 bg-red-600 text-white rounded-md text-sm font-medium hover:bg-red-700 transition"
            >
              Reload
            </button>
            <button
              type="button"
              onClick={() => {
                this.setState({ hasError: false, error: null });
                window.location.hash = "#/";
              }}
              className="px-4 py-2 border border-red-300 bg-white text-red-700 rounded-md text-sm font-medium hover:bg-red-50 transition"
            >
              Go to POS
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
