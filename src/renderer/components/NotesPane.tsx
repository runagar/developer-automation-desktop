import React, { useCallback, useEffect, useRef, useState } from 'react';
import { EditorView, keymap } from '@codemirror/view';
import { EditorState, Prec } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { defaultKeymap, indentWithTab, history, historyKeymap } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, HighlightStyle } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { useNotesStore } from '../stores/notesStore';
import { Dropdown, DropdownDeletableItem, DropdownItem, DropdownSection } from './dropdown';
import TabStrip from './TabStrip';
import './NotesPane.css';

/**
 * Read a theme colour from the DOM.
 *
 * `var()` does not work inside a CM6 `HighlightStyle` — it generates inline
 * style modules that never resolve custom properties — so colours are read at
 * editor-creation time instead.
 *
 * A custom property that is itself defined as `var(--other)` is substituted at
 * computed-value time, so this resolves `--c-code-fg` to a real colour. The
 * `var(` guard is belt and braces: if a browser ever returned the unsubstituted
 * token, CodeMirror would silently render the text with no colour at all.
 */
function getThemeColour(varName: string, fallback: string): string {
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
    if (!value || value.startsWith('var(')) return fallback;
    return value;
  } catch {
    return fallback;
  }
}

function createMarkdownHighlight(): HighlightStyle {
  const bright = getThemeColour('--c-bright', '#00ff00');
  const mid = getThemeColour('--c-mid', '#00cc00');
  const dim = getThemeColour('--c-dim', '#006600');
  // CodeMirror owns its own DOM and highlights through Lezer tags, so it can
  // reuse neither `.inline-code` nor `.markdown-body code`. Sharing the token
  // is the most that can be shared — the background and border halves of the
  // same treatment live in `.cm-monospace` in NotesPane.css.
  const inlineCode = getThemeColour('--c-code-fg', '#00ff00');
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

  const [manageOpen, setManageOpen] = useState(false);
  const [closedTabs, setClosedTabs] = useState<Array<{ id: string; name: string }>>([]);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [tabContextMenu, setTabContextMenu] = useState<{ x: number; y: number } | null>(null);
  const contextTabIdRef = useRef<string | null>(null);
  const manageRef = useRef<HTMLDivElement>(null);

  // Ref for cycleTab so CM keymap can call it without stale closure
  const cycleTabRef = useRef<(dir: number) => void>(() => {});

  // Load tabs on mount
  useEffect(() => {
    void loadTabs(scopeKey);
  }, [scopeKey, loadTabs]);

  // Close manage dropdown and context menu on outside click
  useEffect(() => {
    if (!manageOpen && !tabContextMenu) return;
    const handler = (e: MouseEvent) => {
      if (manageOpen && manageRef.current && !manageRef.current.contains(e.target as Node)) {
        setManageOpen(false);
      }
      if (tabContextMenu) {
        setTabContextMenu(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [manageOpen, tabContextMenu]);

  const handleOpenManage = useCallback(async () => {
    const scope = scopeFromKey(scopeKey);
    const tabs = await window.dad.notesGetClosedTabs(scope);
    setClosedTabs(tabs.map((t: any) => ({ id: t.id, name: t.name || 'Untitled' })));
    setConfirmDeleteId(null);
    setManageOpen(true);
  }, [scopeKey]);

  const handleRestoreTab = useCallback(async (tabId: string) => {
    const restoreTab = useNotesStore.getState().restoreTab;
    await restoreTab(scopeKey, tabId);
    setManageOpen(false);
  }, [scopeKey]);

  const handleDeleteTab = useCallback(async (tabId: string) => {
    await window.dad.notesDeleteTab(tabId);
    setClosedTabs((prev) => prev.filter((t) => t.id !== tabId));
    setConfirmDeleteId(null);
  }, []);

  // Autosave helper — saves to file AND updates store for mirroring
  const saveContent = useCallback((tabId: string, content: string) => {
    isLocalEditRef.current = true;
    updateContent(scopeKey, tabId, content);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      void window.dad.notesSaveContent(tabId, content);
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
        void window.dad.notesSaveContent(prevTabIdRef.current, oldContent);
      }
      editorViewRef.current.destroy();
      editorViewRef.current = null;
    }

    // If editor already exists for this tab, skip
    if (editorViewRef.current) return;

    const currentTabId = activeTabId;
    prevTabIdRef.current = currentTabId;

    // Load content and create editor
    void window.dad.notesLoadContent(currentTabId).then((content) => {
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
          void window.dad.notesSaveContent(capturedTabId, content);
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

  const handleSelectTab = useCallback((tabId: string) => {
    setActiveTab(scopeKey, tabId);
  }, [scopeKey, setActiveTab]);

  const handleRenameTab = useCallback((tabId: string, name: string) => {
    void renameTab(tabId, name);
  }, [renameTab]);

  const handleCloseTab = useCallback((tabId: string) => {
    void closeTab(scopeKey, tabId);
  }, [scopeKey, closeTab]);

  const handleTabContextMenu = useCallback((tabId: string, e: React.MouseEvent) => {
    e.preventDefault();
    contextTabIdRef.current = tabId;
    setTabContextMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const handleExport = useCallback(() => {
    const tabId = contextTabIdRef.current || activeTabIdRef.current;
    if (tabId) void window.dad.notesExportTab(tabId);
  }, []);

  const handleCopyPath = useCallback(async () => {
    const tabId = contextTabIdRef.current || activeTabIdRef.current;
    if (tabId) {
      const ref = await window.dad.notesCopyRef(tabId);
      if (ref) window.dad.clipboardWrite(ref);
    }
  }, []);

  const handleCopyId = useCallback(() => {
    const tabId = contextTabIdRef.current || activeTabIdRef.current;
    if (tabId) {
      const scopeParts = scopeKey.split(':');
      const ref = `${scopeParts.slice(1).join(':')}-${tabId}`;
      window.dad.clipboardWrite(ref);
    }
  }, [activeTabId, scopeKey]);

  return (
    <div className="notes-pane">
      <TabStrip
        tabs={tabs}
        activeId={activeTabId}
        onSelect={handleSelectTab}
        onClose={handleCloseTab}
        closeTitle="Close tab"
        onRename={handleRenameTab}
        onTabContextMenu={handleTabContextMenu}
        trailing={
          <button className="notes-pane__add-tab" onClick={() => void addTab(scopeKey)} title="New tab">+</button>
        }
        actions={
          <div className="notes-pane__manage-container" ref={manageRef}>
            <button className="btn btn--micro" onClick={handleOpenManage} title="Manage closed tabs">Manage Tabs</button>
            {manageOpen && (
              <Dropdown className="notes-pane__manage-menu">
                {closedTabs.length > 0 ? (
                  <DropdownSection label="CLOSED TABS">
                    {closedTabs.map((t) => (
                      <DropdownDeletableItem
                        key={t.id}
                        confirming={confirmDeleteId === t.id}
                        onSelect={() => void handleRestoreTab(t.id)}
                        onConfirmingChange={(confirming) => setConfirmDeleteId(confirming ? t.id : null)}
                        onDelete={() => void handleDeleteTab(t.id)}
                      >
                        {t.name}
                      </DropdownDeletableItem>
                    ))}
                  </DropdownSection>
                ) : (
                  <div className="notes-pane__manage-empty">No closed tabs</div>
                )}
              </Dropdown>
            )}
          </div>
        }
      />

      {/* Tab context menu */}
      {tabContextMenu && (
        <Dropdown
          className="notes-pane__tab-context-menu"
          anchorToParent={false}
          style={{ position: 'fixed', top: tabContextMenu.y, left: tabContextMenu.x }}
          onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
        >
          <DropdownSection label="TAB OPTIONS">
            <DropdownItem onClick={() => { void handleExport(); setTabContextMenu(null); }}>Export</DropdownItem>
            <DropdownItem onClick={() => { void handleCopyPath(); setTabContextMenu(null); requestAnimationFrame(() => editorViewRef.current?.focus()); }}>Copy Path</DropdownItem>
            <DropdownItem onClick={() => { handleCopyId(); setTabContextMenu(null); requestAnimationFrame(() => editorViewRef.current?.focus()); }}>Copy Reference</DropdownItem>
          </DropdownSection>
        </Dropdown>
      )}

      {/* Editor */}
      <div className="notes-pane__editor" ref={editorContainerRef} />
    </div>
  );
}
