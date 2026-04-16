'use client';

import { Component } from 'react';

export default class ErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary] Uncaught error:', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="error-boundary-ui">
          <div className="error-boundary-card">
            <svg width="36" height="36" viewBox="0 0 36 36" fill="none" aria-hidden="true">
              <circle cx="18" cy="18" r="17" stroke="#ef4444" strokeWidth="2"/>
              <path d="M18 10v10" stroke="#ef4444" strokeWidth="2.5" strokeLinecap="round"/>
              <circle cx="18" cy="25" r="1.5" fill="#ef4444"/>
            </svg>
            <h2 className="error-boundary-title">Something went wrong</h2>
            <p className="error-boundary-msg">{this.state.error.message}</p>
            <button
              className="btn-convert"
              style={{ marginTop: 20 }}
              onClick={() => this.setState({ error: null })}
            >
              Try again
            </button>
          </div>
        </div>
      );
    }
    return <>{this.props.children}</>;
  }
}
