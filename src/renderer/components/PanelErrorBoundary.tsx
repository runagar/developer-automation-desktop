import React from 'react';
import './PanelErrorBoundary.css';

interface Props {
  panelId: string;
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

export default class PanelErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  reset = (): void => this.setState({ error: null });

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div className="panel-error">
          <div className="panel-error__icon">⚠</div>
          <div className="panel-error__message">{this.state.error.message}</div>
          <button className="btn btn--micro" onClick={this.reset}>RETRY</button>
        </div>
      );
    }
    return this.props.children;
  }
}
