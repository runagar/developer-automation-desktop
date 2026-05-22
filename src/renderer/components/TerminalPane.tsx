import React, { useEffect, useRef } from 'react';
import { Terminal, ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Session } from '../../main/types';
import '@xterm/xterm/css/xterm.css';
import './TerminalPane.css';

interface Props {
  session: Session;
  isActive: boolean;
  onRename: (id: string, name: string) => void;
}

const XTERM_THEMES: Record<string, ITheme> = {
  'pipboy-3000': {
    background:          '#000000',
    foreground:          '#00ff00',
    cursor:              '#00ff00',
    cursorAccent:        '#000000',
    selectionBackground:         'rgba(0, 255, 0, 0.4)',
    selectionInactiveBackground: 'rgba(0, 255, 0, 0.4)',
    selectionForeground:         '#006600',
    black:               '#000000',
    red:                 '#ff4444',
    green:               '#00ff00',
    yellow:              '#ffff00',
    blue:                '#4488ff',
    magenta:             '#ff44ff',
    cyan:                '#00ffff',
    white:               '#00cc00',
    brightBlack:         '#003300',
    brightRed:           '#ff6666',
    brightGreen:         '#66ff66',
    brightYellow:        '#ffff66',
    brightBlue:          '#6699ff',
    brightMagenta:       '#ff66ff',
    brightCyan:          '#66ffff',
    brightWhite:         '#00ff00',
  },
  'pipboy-3000a': {
    background:          '#000000',
    foreground:          '#ff9f1c',
    cursor:              '#ff9f1c',
    cursorAccent:        '#000000',
    selectionBackground:         'rgba(255, 159, 28, 0.4)',
    selectionInactiveBackground: 'rgba(255, 159, 28, 0.4)',
    selectionForeground:         '#7a4e00',
    black:               '#000000',
    red:                 '#ff4444',
    green:               '#00cc44',
    yellow:              '#ffdd00',
    blue:                '#4488ff',
    magenta:             '#ff44ff',
    cyan:                '#00cccc',
    white:               '#cc8000',
    brightBlack:         '#3d2400',
    brightRed:           '#ff6666',
    brightGreen:         '#44ee66',
    brightYellow:        '#ffee44',
    brightBlue:          '#6699ff',
    brightMagenta:       '#ff66ff',
    brightCyan:          '#44dddd',
    brightWhite:         '#ff9f1c',
  },
};

function getXtermTheme(): ITheme {
  const themeId = document.documentElement.getAttribute('data-theme') ?? 'pipboy-3000';
  return XTERM_THEMES[themeId] ?? XTERM_THEMES['pipboy-3000'];
}

export default function TerminalPane({ session, isActive, onRename }: Props): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const openedRef = useRef(false); // has term.open() been called yet?
  const [editingName, setEditingName] = React.useState(false);
  const [nameValue, setNameValue] = React.useState(session.name);
  const nameInputRef = useRef<HTMLInputElement>(null);

  // Create the xterm Terminal once on mount. We don't call term.open() yet —
  // that's deferred until first activation so dimensions are available.
  useEffect(() => {
    const term = new Terminal({
      fontFamily: '"Roboto Mono", "Courier New", monospace',
      fontSize: 14,
      lineHeight: 1.2,
      theme: getXtermTheme(),
      cursorBlink: true,
      cursorStyle: 'block',
      allowTransparency: false,
      scrollback: 10000,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());

    term.onData((data) => {
      window.agentSmith.ptyWrite(session.id, data);
    });

    term.onResize(({ cols, rows }) => {
      window.agentSmith.ptyResize(session.id, cols, rows);
    });

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    return () => {
      if (containerRef.current) {
        (containerRef.current as any).__selObs?.disconnect();
      }
      term.dispose();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Open the terminal into the DOM the first time it becomes active.
  // After that, just re-fit — the terminal stays alive between activations.
  useEffect(() => {
    if (!isActive || !containerRef.current || !termRef.current || !fitAddonRef.current) return;

    if (!openedRef.current) {
      openedRef.current = true;
      termRef.current.open(containerRef.current);

      // Wire up selection colour override via MutationObserver
      const selectionContainer = containerRef.current.querySelector('.xterm-selection');
      if (selectionContainer) {
        const applySelColor = (el: HTMLElement) => {
          el.style.backgroundColor = (getXtermTheme().selectionBackground as string);
        };
        const selObs = new MutationObserver((muts) => {
          for (const mut of muts) {
            mut.addedNodes.forEach((n) => {
              if (n instanceof HTMLElement) applySelColor(n);
            });
          }
        });
        selObs.observe(selectionContainer, { childList: true });
        (containerRef.current as any).__selObs = selObs;
      }
    }

    // Re-fit after becoming active and notify PTY of new dimensions so the CLI redraws.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      fitAddonRef.current?.fit();
      const term = termRef.current;
      if (term) {
        window.agentSmith.ptyResize(session.id, term.cols, term.rows);
      }
    }));
  }, [isActive]);

  // Write incoming PTY data for this session's terminal regardless of visibility.
  // xterm buffers data before open(), so history accumulates even while hidden.
  useEffect(() => {
    const id = session.id;
    const unsub = window.agentSmith.onPtyData((sessionId, data) => {
      if (sessionId === id && termRef.current) {
        termRef.current.write(data);
      }
    });
    return unsub;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fit terminal whenever the container is resized (covers window resize,
  // panel resizes, and the initial render after a session switch)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => fitAddonRef.current?.fit());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Sync name field when session changes (e.g. switching active session)
  useEffect(() => {
    setNameValue(session.name);
    setEditingName(false);
  }, [session.id, session.name]);

  function startEditing(): void {
    setNameValue(session.name);
    setEditingName(true);
    setTimeout(() => nameInputRef.current?.select(), 0);
  }

  function commitRename(): void {
    const trimmed = nameValue.trim();
    if (trimmed && trimmed !== session.name) {
      onRename(session.id, trimmed);
    } else {
      setNameValue(session.name);
    }
    setEditingName(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') commitRename();
    if (e.key === 'Escape') { setNameValue(session.name); setEditingName(false); }
  }

  // Re-apply xterm theme when the data-theme attribute changes on <html>
  useEffect(() => {
    const observer = new MutationObserver(() => {
      if (termRef.current) {
        termRef.current.options.theme = getXtermTheme();
      }
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);

  // Cleanup on unmount — handled inside the mount useEffect above.

  return (
    <div className="terminal-pane" style={isActive ? undefined : { display: 'none' }}>
      <div className="terminal-pane__header">
        {editingName ? (
          <input
            ref={nameInputRef}
            className="terminal-pane__name-input"
            value={nameValue}
            onChange={(e) => setNameValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={onKeyDown}
            spellCheck={false}
            autoComplete="off"
          />
        ) : (
          <span
            className="terminal-pane__name terminal-pane__name--editable"
            title="Click to rename"
            onClick={startEditing}
          >
            {session.name}
          </span>
        )}
        {session.project && (
          <span className="terminal-pane__project">[ {session.project} ]</span>
        )}
        <span className="terminal-pane__dir">{session.workingDir}</span>
      </div>
      {session.dead && (
        <div className="terminal-pane__dead-banner">
          ⚠ SESSION TERMINATED — SCROLLBACK PRESERVED
        </div>
      )}
      <div className="terminal-pane__terminal" ref={containerRef} />
    </div>
  );
}
