import React, { useCallback, useEffect, useRef, useState } from 'react';
import { EditorView, keymap } from '@codemirror/view';
import { EditorState, Prec } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { defaultKeymap, indentWithTab, history, historyKeymap } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, HighlightStyle } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { useNotesStore, NotesTabState } from '../stores/notesStore';
import './NotesPane.css';

// Markdown inline rendering highlight style
// CSS var() doesn't work in CM6 HighlightStyle — it generates inline style modules
// that don't resolve vars. We read theme colours from DOM at creation time instead.
function getThemeColour(varName: string, fallback: string): string {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(varName).trim() || fallback;
  } catch {
    return fallback;
  }
}

function createMarkdownHighlight(): HighlightStyle {
  const bright = getThemeColour('--c-bright', '#00ff00');
  const mid = getThemeColour('--c-mid', '#00cc00');
  const dim = getThemeColour('--c-dim', '#006600');
  const inlineCode = getThemeColour('--c-inline-code', '#0055dd');
  const blockquote = getThemeColour('--c-blockquote', '#cc7f16');
  const mdMarker = getThemeColour('--c-md-marker', '#0055dd');

  return HighlightStyle.define([
    { tag: tags.heading, fontWeight: '700', color: bright },
    { tag: tags.strong, fontWeight: '700', color: bright },
    { tag: tags.emphasis, fontStyle: 'italic', color: bright },
    { tag: tags.monospace, color: inlineCode },
    { tag: tags.link, textDecoration: 'underline', color: bright },
    { tag: tags.url, color: mid },
    { tag: tags.quote, fontStyle: 'italic', color: blockquote },
    { tag: tags.processingInstruction, color: mdMarker },
    { tag: tags.content, color: bright },
    { tag: tags.contentSeparator, color: mdMarker },
    { tag: tags.strikethrough, textDecoration: 'line-through' },
    { tag: tags.meta, color: dim },
  ]);
}

interface Props {
  scopeKey: string;
  isGlobal: boolean;
}

function scopeFromKey(key: string): { kind: string; id: string } {
  const [kind, ...rest] = key.split(':');
  return { kind, id: rest.join(':') };
}

export default function NotesPane({ scopeKey, isGlobal }: Props): React.ReactElement {
  const scopeState = useNotesStore((s) => s.scopes.get(scopeKey));
  const loadTabs = useNotesStore((s) => s.loadTabs);
  const addTab = useNotesStore((s) => s.addTab);
  const closeTab = useNotesStore((s) => s.closeTab);
  const renameTab = useNotesStore((s) => s.renameTab);
  const setActiveTab = useNotesStore((s) => s.setActiveTab);
  const updateContent = useNotesStore((s) => s.updateContent);

  const tabs = scopeState?.tabs ?? [];
  const activeTabId = scopeState?.activeTabId ?? null;
  const contentVersion = scopeState?.contentVersion ?? 0;
  const storedContent = activeTabId ? scopeState?.tabContents.get(activeTabId) : undefined;

  const editorContainerRef = useRef<HTMLDivElement>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentVersionRef = useRef(contentVersion);
  const isLocalEditRef = useRef(false);
  const activeTabIdRef = useRef(activeTabId);
  const prevTabIdRef = useRef<string | null>(null);
  const focusAfterSwitchRef = useRef(false);
  activeTabIdRef.current = activeTabId;

  // Renaming state
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [closedTabs, setClosedTabs] = useState<Array<{ id: string; name: string }>>([]);
  const [tabContextMenu, setTabContextMenu] = useState<{ x: number; y: number } | null>(null);
  const contextTabIdRef = useRef<string | null>(null);
  const restoreRef = useRef<HTMLDivElement>(null);

  // Tab scroll
  const tabBarRef = useRef<HTMLDivElement>(null);

  // Ref for cycleTab so CM keymap can call it without stale closure
  const cycleTabRef = useRef<(dir: number) => void>(() => {});

  // Load tabs on mount
  useEffect(() => {
    void loadTabs(scopeKey);
  }, [scopeKey, loadTabs]);

  // Close restore dropdown and context menu on outside click
  useEffect(() => {
    if (!restoreOpen && !tabContextMenu) return;
    const handler = (e: MouseEvent) => {
      if (restoreOpen && restoreRef.current && !restoreRef.current.contains(e.target as Node)) {
        setRestoreOpen(false);
      }
      if (tabContextMenu) {
        setTabContextMenu(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [restoreOpen, tabContextMenu]);

  const handleOpenRestore = useCallback(async () => {
    const scope = scopeFromKey(scopeKey);
    const tabs = await window.agentSmith.notesGetClosedTabs(scope);
    setClosedTabs(tabs.map((t: any) => ({ id: t.id, name: t.name || t.id })));
    setRestoreOpen(true);
  }, [scopeKey]);

  const handleRestoreTab = useCallback(async (tabId: string) => {
    const restoreTab = useNotesStore.getState().restoreTab;
    await restoreTab(scopeKey, tabId);
    setRestoreOpen(false);
  }, [scopeKey]);

  // Autosave helper — saves to file AND updates store for mirroring
  const saveContent = useCallback((tabId: string, content: string) => {
    isLocalEditRef.current = true;
    updateContent(scopeKey, tabId, content);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      void window.agentSmith.notesSaveContent(tabId, content);
    }, 500);
  }, [scopeKey, updateContent]);

  // Mirror: detect content updates from other panels sharing this scope
  useEffect(() => {
    if (isLocalEditRef.current) {
      isLocalEditRef.current = false;
      contentVersionRef.current = contentVersion;
      return;
    }
    if (contentVersion !== contentVersionRef.current && storedContent !== undefined && editorViewRef.current) {
      const currentContent = editorViewRef.current.state.doc.toString();
      if (currentContent !== storedContent) {
        editorViewRef.current.dispatch({
          changes: { from: 0, to: currentContent.length, insert: storedContent },
        });
      }
      contentVersionRef.current = contentVersion;
    }
  }, [contentVersion, storedContent]);

  // Create/update CodeMirror when active tab changes
  useEffect(() => {
    if (!activeTabId || !editorContainerRef.current) return;

    // Check if this panel currently has focus (before destroying editor)
    const hadFocus = editorContainerRef.current.closest('.workspace-panel')?.contains(document.activeElement) ?? false;

    // Destroy previous editor and save its content under the PREVIOUS tab ID
    if (editorViewRef.current && prevTabIdRef.current && prevTabIdRef.current !== activeTabId) {
      const oldContent = editorViewRef.current.state.doc.toString();
      if (oldContent) {
        void window.agentSmith.notesSaveContent(prevTabIdRef.current, oldContent);
      }
      editorViewRef.current.destroy();
      editorViewRef.current = null;
    }

    // If editor already exists for this tab, skip
    if (editorViewRef.current) return;

    const currentTabId = activeTabId;
    prevTabIdRef.current = currentTabId;

    // Load content and create editor
    void window.agentSmith.notesLoadContent(currentTabId).then((content) => {
      if (!editorContainerRef.current) return;
      // Guard: if activeTabId changed while loading, abort
      if (activeTabIdRef.current !== currentTabId) return;

      const view = new EditorView({
        state: EditorState.create({
          doc: content,
          extensions: [
            keymap.of([
              ...defaultKeymap,
              ...historyKeymap,
              indentWithTab,
            ]),
            history(),
            markdown({ codeLanguages: languages }),
            syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
            EditorView.updateListener.of((update) => {
              if (update.docChanged && activeTabIdRef.current) {
                saveContent(activeTabIdRef.current, update.state.doc.toString());
              }
            }),
            EditorView.theme({
              '&': { height: '100%', fontSize: '13px' },
              '.cm-content': { fontFamily: 'var(--font)', caretColor: 'var(--c-bright)' },
              '.cm-cursor': { borderLeftColor: 'var(--c-bright)' },
              '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'rgba(0, 255, 0, 0.2)' },
              '.cm-gutters': { display: 'none' },
              '.cm-scroller': { overflow: 'auto' },
            }, { dark: true }),
            EditorView.baseTheme({
              '&.cm-editor': { backgroundColor: 'transparent' },
              '.cm-content': { color: 'var(--c-bright)' },
            }),
            // Prevent Ctrl+Tab from being captured by CM
            EditorView.domEventHandlers({
              keydown: (e) => {
                if (e.key === 'Tab' && (e.ctrlKey || e.metaKey)) return false;
                return false;
              },
            }),
            // Alt+Left/Right for tab cycling — highest priority to override CM's default Alt+Arrow
            Prec.highest(keymap.of([
              { key: 'Alt-ArrowLeft', run: () => { cycleTabRef.current(-1); return true; } },
              { key: 'Alt-ArrowRight', run: () => { cycleTabRef.current(1); return true; } },
            ])),
          ],
        }),
        parent: editorContainerRef.current,
      });

      editorViewRef.current = view;
      // Restore focus if this panel had it before or was triggered by keyboard
      if (hadFocus || focusAfterSwitchRef.current) {
        focusAfterSwitchRef.current = false;
        requestAnimationFrame(() => view.focus());
      }
    });

    const capturedTabId = currentTabId;
    return () => {
      if (editorViewRef.current) {
        const content = editorViewRef.current.state.doc.toString();
        if (capturedTabId && content) {
          void window.agentSmith.notesSaveContent(capturedTabId, content);
        }
        editorViewRef.current.destroy();
        editorViewRef.current = null;
      }
    };
  }, [activeTabId]);

  const cycleTab = useCallback((dir: number) => {
    if (tabs.length < 2 || !activeTabId) return;
    const idx = tabs.findIndex((t) => t.id === activeTabId);
    const next = (idx + dir + tabs.length) % tabs.length;
    focusAfterSwitchRef.current = true;
    setActiveTab(scopeKey, tabs[next].id);
  }, [tabs, activeTabId, scopeKey, setActiveTab]);
  cycleTabRef.current = cycleTab;

  const handleTabClick = useCallback((tab: NotesTabState) => {
    if (tab.id === activeTabId) {
      // Click on active tab → rename
      setRenamingTabId(tab.id);
      setRenameValue(tab.name);
    } else {
      setActiveTab(scopeKey, tab.id);
    }
  }, [activeTabId, scopeKey, setActiveTab]);

  const handleRenameSubmit = useCallback(() => {
    if (renamingTabId && renameValue.trim()) {
      void renameTab(renamingTabId, renameValue.trim());
    }
    setRenamingTabId(null);
  }, [renamingTabId, renameValue, renameTab]);

  const handleCloseTab = useCallback((tabId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    void closeTab(scopeKey, tabId);
  }, [scopeKey, closeTab]);

  const scrollTabs = useCallback((dir: number) => {
    if (tabBarRef.current) {
      tabBarRef.current.scrollLeft += dir * 80;
    }
  }, []);

  const handleExport = useCallback(() => {
    const tabId = contextTabIdRef.current || activeTabIdRef.current;
    if (tabId) void window.agentSmith.notesExportTab(tabId);
  }, []);

  const handleCopyPath = useCallback(async () => {
    const tabId = contextTabIdRef.current || activeTabIdRef.current;
    if (tabId) {
      const ref = await window.agentSmith.notesCopyRef(tabId);
      if (ref) window.agentSmith.clipboardWrite(ref);
    }
  }, []);

  const handleCopyId = useCallback(() => {
    const tabId = contextTabIdRef.current || activeTabIdRef.current;
    if (tabId) {
      const scopeParts = scopeKey.split(':');
      const ref = `${scopeParts.slice(1).join(':')}-${tabId}`;
      window.agentSmith.clipboardWrite(ref);
    }
  }, [activeTabId, scopeKey]);

  return (
    <div className="notes-pane">
      {/* Tab bar */}
      <div className="notes-pane__tab-bar">
        <button className="notes-pane__scroll-btn" onClick={() => scrollTabs(-1)}>◀</button>
        <div className="notes-pane__tabs" ref={tabBarRef}>
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`notes-pane__tab${tab.id === activeTabId ? ' notes-pane__tab--active' : ''}`}
              onClick={() => handleTabClick(tab)}
              onContextMenu={(e) => {
                e.preventDefault();
                contextTabIdRef.current = tab.id;
                setTabContextMenu({ x: e.clientX, y: e.clientY });
              }}
            >
              {renamingTabId === tab.id ? (
                <input
                  className="notes-pane__tab-rename"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={handleRenameSubmit}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleRenameSubmit(); if (e.key === 'Escape') setRenamingTabId(null); }}
                  onFocus={(e) => e.target.select()}
                  autoFocus
                  spellCheck={false}
                />
              ) : (
                <span className="notes-pane__tab-name">{tab.name}</span>
              )}
              <button
                className="notes-pane__tab-close"
                onClick={(e) => handleCloseTab(tab.id, e)}
                title="Close tab"
              >✕</button>
            </div>
          ))}
        </div>
        <button className="notes-pane__scroll-btn" onClick={() => scrollTabs(1)}>▶</button>
        <button className="notes-pane__add-tab" onClick={() => void addTab(scopeKey)} title="New tab">+</button>
        <div className="notes-pane__actions">
          <div className="notes-pane__restore-container" ref={restoreRef}>
            <button className="btn btn--micro" onClick={handleOpenRestore} title="Restore closed tabs">Restore Tab</button>
            {restoreOpen && closedTabs.length > 0 && (
              <div className="notes-pane__restore-dropdown">
                <div className="notes-pane__restore-section">CLOSED TABS</div>
                {closedTabs.map((t) => (
                  <button key={t.id} className="notes-pane__restore-item" onClick={() => void handleRestoreTab(t.id)}>
                    {t.name}
                  </button>
                ))}
              </div>
            )}
            {restoreOpen && closedTabs.length === 0 && (
              <div className="notes-pane__restore-dropdown">
                <div className="notes-pane__restore-empty">No closed tabs</div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Tab context menu */}
      {tabContextMenu && (
        <div
          className="notes-pane__tab-context"
          style={{ top: tabContextMenu.y, left: tabContextMenu.x }}
          onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
        >
          <button className="notes-pane__restore-item" onClick={() => { void handleExport(); setTabContextMenu(null); }}>Export</button>
          <button className="notes-pane__restore-item" onClick={() => { void handleCopyPath(); setTabContextMenu(null); requestAnimationFrame(() => editorViewRef.current?.focus()); }}>Copy Path</button>
          <button className="notes-pane__restore-item" onClick={() => { handleCopyId(); setTabContextMenu(null); requestAnimationFrame(() => editorViewRef.current?.focus()); }}>Copy Reference</button>
        </div>
      )}

      {/* Editor */}
      <div className="notes-pane__editor" ref={editorContainerRef} />
    </div>
  );
}
