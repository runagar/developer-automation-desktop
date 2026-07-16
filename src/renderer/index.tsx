import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { initTheme } from './components/SettingsMenu';
import { initZoom } from './components/ZoomControl';
import { initCrtEffects } from './components/crtEffects';
import './styles/global.css';
import './styles/pipboy.css';

// Suppress the benign "ResizeObserver loop completed with undelivered
// notifications" error. This is a spec-compliant browser behaviour, not a real
// error, but webpack-dev-server's overlay treats it as one.
window.addEventListener('error', (e) => {
  if (e.message?.includes('ResizeObserver loop')) {
    e.stopImmediatePropagation();
    e.preventDefault();
  }
});

// Apply saved theme, zoom, and CRT effects before first render
initTheme();
initZoom();
initCrtEffects();

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ color: '#ff4040', background: '#000', padding: 20, fontFamily: 'monospace' }}>
          <h2>RENDER ERROR</h2>
          <pre>{this.state.error.message}</pre>
          <pre>{this.state.error.stack}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

const container = document.getElementById('root');
if (!container) {
  document.body.innerHTML = '<div style="color:#ff4040;font-family:monospace;padding:20px">ERROR: #root element not found</div>';
} else {
  const root = createRoot(container);
  root.render(
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
}
