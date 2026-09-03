import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorView, keymap } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { json } from '@codemirror/lang-json';
import { defaultKeymap, indentWithTab, history, historyKeymap } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { ChevronDown, RotateCcw, X } from 'lucide-react';
import { usePanelFocus } from '../dashboard/usePanelFocus';
import { useTopLayer } from './dropdown';
import { sendsBody } from '../../main/restMethods';
import { useRestStore, REST_METHODS, effectiveMethod } from '../stores/restStore';
import {
  HeaderRow, ParamRow, buildQuery, defaultHeaderRows, defaultParamRows, effectiveValue,
  substitutePath, takesBody,
} from '../stores/restCraft';
import './RestCrafterPane.css';

/** Shown for a field the contract documents no default for; never sent. */
const EMPTY_PLACEHOLDER = '...';

/**
 * Close an open dropdown when the pointer goes down anywhere outside it.
 *
 * Shared by the three dropdowns in this pane so they cannot drift apart; a
 * click inside must not close it, or picking a value would never fire.
 */
function useDismissOnOutsideClick(
  open: boolean, wrapRef: React.RefObject<HTMLElement>, close: () => void
): void {
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) closeRef.current();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, wrapRef]);
}

/**
 * A menu list raised into the top layer so it paints above every panel.
 *
 * Shared by this pane's three menus; see `useTopLayer` for why a z-index
 * cannot achieve this. Anchors to its DOM parent, which each caller has
 * already made the positioned wrapper.
 */
function Menu({ className, children }: MenuProps): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  useTopLayer(ref);
  return <div ref={ref} className={className}>{children}</div>;
}

interface MenuProps {
  className: string;
  children: React.ReactNode;
}

interface ValueFieldProps {
  value: string;
  options: string[];
  placeholder: string;
  title?: string;
  /** Rendered inside the field, before the input — used by the reset button. */
  prefix?: React.ReactNode;
  onChange: (value: string) => void;
}

/**
 * An editable field with an optional list of documented values.
 *
 * A plain `<select>` would cover the enum case but would stop the user
 * overwriting `Accept` (requirement 6.2.2) or clearing a header so it is not
 * sent at all (requirement 6.2.6), so the input always stays free-text.
 */
function ValueField({
  value, options, placeholder, title, prefix, onChange,
}: ValueFieldProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  useDismissOnOutsideClick(open, wrapRef, () => setOpen(false));

  return (
    <div className="rest-crafter-pane__field" ref={wrapRef}>
      {prefix}
      <input
        className="rest-crafter-pane__input"
        value={value}
        placeholder={placeholder}
        title={title}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
      />
      {options.length > 0 && (
        <>
          <button
            ref={toggleRef}
            className="rest-crafter-pane__field-toggle"
            title="Documented values"
            onClick={() => setOpen((v) => !v)}
          >
            <ChevronDown size={14} strokeWidth={2.75} />
          </button>
          {open && (
            <Menu className="rest-crafter-pane__options">
              {options.map((option) => (
                <button
                  key={option}
                  className="rest-crafter-pane__option"
                  onClick={() => {
                    onChange(option);
                    setOpen(false);
                    // The dropdown unmounts on click, which would otherwise
                    // drop focus to the body and unfocus the whole panel.
                    toggleRef.current?.focus();
                  }}
                >
                  {option}
                </button>
              ))}
            </Menu>
          )}
        </>
      )}
    </div>
  );
}

/** REST Crafter body — compose and execute a call against the picked operation. */
export default function RestCrafterPane(): React.ReactElement {
  const rootRef = useRef<HTMLDivElement>(null);
  usePanelFocus(rootRef);

  // Subscribes to the whole store: this pane reads nearly every crafter field,
  // so a granular selector would gain nothing. There is no periodic poll here,
  // unlike sessionStore, so a change always means something the pane renders.
  const {
    selection, environments, environmentKey, authValue, authManual,
    headerValues, customHeaders, paramValues, customParams,
    bodyText, activeTab, tokenLoading, sending, crafterError, methodOverride,
    loadEnvironments, setEnvironment, setAuthValue, resetAuth, setHeaderValue,
    addCustomHeader, updateCustomHeader, removeCustomHeader,
    setParamValue, addCustomParam, updateCustomParam, removeCustomParam,
    setBodyText, setActiveTab, setMethodOverride, send, clearCrafterError,
  } = useRestStore();

  const [envOpen, setEnvOpen] = useState(false);
  const envRef = useRef<HTMLDivElement>(null);
  const envButtonRef = useRef<HTMLButtonElement>(null);

  const [methodOpen, setMethodOpen] = useState(false);
  const methodRef = useRef<HTMLDivElement>(null);
  const methodButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    void loadEnvironments();
  }, [loadEnvironments]);

  // Acquire the environment's token when the panel is first used. The Rest Room
  // tab only mounts once the user activates it, so this is a user action rather
  // than an unsolicited authentication at app startup.
  useEffect(() => {
    if (!selection || authManual || authValue.length > 0) return;
    void resetAuth();
  }, [selection, authManual, authValue, resetAuth]);

  useDismissOnOutsideClick(envOpen, envRef, () => setEnvOpen(false));
  useDismissOnOutsideClick(methodOpen, methodRef, () => setMethodOpen(false));

  const headerRows = useMemo(
    () => defaultHeaderRows(selection, customHeaders), [selection, customHeaders]
  );
  const paramRows = useMemo(
    () => defaultParamRows(selection, customParams), [selection, customParams]
  );

  const environment = environments.find((e) => e.key === environmentKey);
  const apiPath = selection
    ? `${substitutePath(selection.fullPath, paramRows, paramValues)}`
      + `${buildQuery(paramRows, paramValues)}`
    : '';

  // --- Body editor ---------------------------------------------------------
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Distinguishes DAD replacing the doc from the user typing; without it every
  // selection change would mark the body as hand-edited.
  const programmaticRef = useRef(false);
  const setBodyRef = useRef(setBodyText);
  setBodyRef.current = setBodyText;
  const bodyTextRef = useRef(bodyText);
  bodyTextRef.current = bodyText;

  const operationKey = selection
    ? `${selection.serviceName}|${selection.contractType}|${selection.contractVersion}`
      + `|${selection.method}|${selection.path}|${selection.acceptVersion ?? ''}`
    : '';

  useEffect(() => {
    if (activeTab !== 'body' || !editorRef.current) return;

    // Recreated rather than having its doc replaced: CM6 does not reset its
    // history on a doc swap, so undo would cross operation boundaries.
    const view = new EditorView({
      state: EditorState.create({
        doc: bodyTextRef.current,
        extensions: [
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          history(),
          json(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            setBodyRef.current(update.state.doc.toString(), !programmaticRef.current);
          }),
          EditorView.theme({
            '&': { height: '100%', fontSize: '12px' },
            '.cm-content': { fontFamily: 'var(--font)', caretColor: 'var(--c-bright)' },
            '.cm-cursor': { borderLeftColor: 'var(--c-bright)' },
            '.cm-gutters': { display: 'none' },
            '.cm-scroller': { overflow: 'auto' },
          }, { dark: true }),
          EditorView.baseTheme({
            '&.cm-editor': { backgroundColor: 'transparent' },
            '.cm-content': { color: 'var(--c-bright)' },
          }),
        ],
      }),
      parent: editorRef.current,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [activeTab, operationKey]);

  // Mirror a store-driven body replacement (a new selection, a restored draft)
  // into a live editor without marking it as a user edit.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === bodyText) return;
    programmaticRef.current = true;
    view.dispatch({ changes: { from: 0, to: current.length, insert: bodyText } });
    programmaticRef.current = false;
  }, [bodyText]);

  const handleSend = useCallback(() => { void send(); }, [send]);

  if (!selection) {
    return (
      <div className="app-empty" ref={rootRef}>
        <div className="app-empty__text">REST CRAFTER</div>
        <div className="app-empty__sub">PICK AN OPERATION IN THE API PICKER</div>
      </div>
    );
  }

  const method = effectiveMethod(selection, methodOverride);

  const renderHeaderRow = (row: HeaderRow): React.ReactElement => {
    const custom = row.kind === 'custom'
      ? customHeaders.find((h) => `custom:${h.id}` === row.key) ?? null
      : null;
    return (
      <div className="rest-crafter-pane__row" key={row.key}>
        {custom ? (
          <input
            className="rest-crafter-pane__label-input"
            value={custom.name}
            placeholder="Header name"
            spellCheck={false}
            onChange={(e) => updateCustomHeader(custom.id, { name: e.target.value })}
          />
        ) : (
          <span className="rest-crafter-pane__label" title={row.description || undefined}>
            {row.name}:
          </span>
        )}
        {row.kind === 'auth' ? (
          <ValueField
            value={authValue}
            options={[]}
            placeholder={tokenLoading ? 'Fetching token…' : EMPTY_PLACEHOLDER}
            prefix={(
              <button
                className="rest-crafter-pane__reset"
                title="Replace with a token fetched for the selected environment"
                // Never disabled: a disabled button loses focus, which would
                // unfocus the whole panel while the token is being fetched.
                onClick={() => { if (!tokenLoading) void resetAuth(); }}
              >
                <RotateCcw size={11} />
              </button>
            )}
            onChange={setAuthValue}
          />
        ) : (
          <ValueField
            value={effectiveValue(row, headerValues)}
            options={row.options}
            placeholder={EMPTY_PLACEHOLDER}
            title={row.description || undefined}
            onChange={(value) => setHeaderValue(row.key, value)}
          />
        )}
        {custom && (
          <button
            className="rest-crafter-pane__remove"
            title="Remove header"
            onClick={() => removeCustomHeader(custom.id)}
          >
            <X size={11} />
          </button>
        )}
      </div>
    );
  };

  const renderParamRow = (row: ParamRow): React.ReactElement => {
    const custom = row.removable
      ? customParams.find((p) => `custom:${p.id}` === row.key) ?? null
      : null;
    return (
      <div className="rest-crafter-pane__row" key={row.key}>
        <span className={`rest-crafter-pane__marker rest-crafter-pane__marker--${row.location}`}>
          [{row.location.toUpperCase()}]
        </span>
        {custom ? (
          <input
            className="rest-crafter-pane__label-input"
            value={custom.name}
            placeholder="Parameter name"
            spellCheck={false}
            onChange={(e) => updateCustomParam(custom.id, { name: e.target.value })}
          />
        ) : (
          <span className="rest-crafter-pane__label" title={row.description || undefined}>
            {row.name}:
          </span>
        )}
        <ValueField
          value={effectiveValue(row, paramValues)}
          options={row.options}
          placeholder={EMPTY_PLACEHOLDER}
          title={row.description || undefined}
          onChange={(value) => setParamValue(row.key, value)}
        />
        {custom && (
          <button
            className="rest-crafter-pane__remove"
            title="Remove parameter"
            onClick={() => removeCustomParam(custom.id)}
          >
            <X size={11} />
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="rest-crafter-pane" ref={rootRef}>
      <div className="rest-crafter-pane__url-bar">
        <div className="rest-crafter-pane__env" ref={envRef}>
          <button
            ref={envButtonRef}
            className="rest-crafter-pane__env-button"
            onClick={() => setEnvOpen((v) => !v)}
            title="Target environment"
          >
            <span>{environmentKey}</span>
            <ChevronDown size={14} strokeWidth={2.75} />
          </button>
          {envOpen && (
            <Menu className="rest-crafter-pane__menu rest-crafter-pane__menu--wide">
              {environments.map((env) => (
                <button
                  key={env.key}
                  className={
                    'rest-crafter-pane__menu-item'
                    + (env.key === environmentKey ? ' rest-crafter-pane__menu-item--active' : '')
                  }
                  title={env.baseUrl}
                  onClick={() => {
                    setEnvOpen(false);
                    void setEnvironment(env.key);
                    // The list unmounts on click, which would otherwise drop
                    // focus to the body and unfocus the whole panel.
                    envButtonRef.current?.focus();
                  }}
                >
                  {env.label}
                </button>
              ))}
            </Menu>
          )}
        </div>

        <div className="rest-crafter-pane__url" title={`${environment?.baseUrl ?? ''}${apiPath}`}>
          <span className="rest-crafter-pane__url-base">{environment?.baseUrl ?? ''}</span>
          <span className="rest-crafter-pane__url-path">{apiPath}</span>
        </div>

        <button
          className="btn btn--primary rest-crafter-pane__send"
          onClick={handleSend}
          disabled={sending}
          title={sending ? 'Waiting for a response' : `Send this ${method} request`}
        >
          {sending ? 'SENDING' : method}
        </button>

        <div className="rest-crafter-pane__method" ref={methodRef}>
          <button
            ref={methodButtonRef}
            className="btn btn--primary btn--icon rest-crafter-pane__method-toggle"
            title="Method to send with"
            aria-label="Method to send with"
            disabled={sending}
            onClick={() => setMethodOpen((v) => !v)}
          >
            <ChevronDown size={14} strokeWidth={2.75} />
          </button>
          {methodOpen && (
            <Menu className="rest-crafter-pane__menu rest-crafter-pane__menu--right">
              {REST_METHODS.map((option) => (
                <button
                  key={option}
                  className={
                    'rest-crafter-pane__menu-item'
                    + (option === method ? ' rest-crafter-pane__menu-item--active' : '')
                  }
                  title={
                    option === selection.method
                      ? `${option} — documented by this operation`
                      : `${option} — not documented by this operation`
                  }
                  onClick={() => {
                    setMethodOpen(false);
                    setMethodOverride(option);
                    // The list unmounts on click, which would otherwise drop
                    // focus to the body and unfocus the whole panel.
                    methodButtonRef.current?.focus();
                  }}
                >
                  {option}
                </button>
              ))}
            </Menu>
          )}
        </div>
      </div>

      {crafterError && (
        <div className="rest-crafter-pane__error">
          <span>{crafterError}</span>
          <button className="btn btn--micro" onClick={clearCrafterError}>DISMISS</button>
        </div>
      )}

      <div className="rest-crafter-pane__tabs">
        {(['headers', 'parameters', 'body'] as const).map((tab) => (
          <button
            key={tab}
            className={
              'rest-crafter-pane__tab'
              + (activeTab === tab ? ' rest-crafter-pane__tab--active' : '')
            }
            onClick={() => setActiveTab(tab)}
          >
            {tab.toUpperCase()}
          </button>
        ))}
      </div>

      <div className="rest-crafter-pane__content">
        {activeTab === 'headers' && (
          <>
            <div className="rest-crafter-pane__table">
              {headerRows.map(renderHeaderRow)}
            </div>
            <button className="rest-crafter-pane__add" onClick={addCustomHeader}>
              + add header
            </button>
          </>
        )}

        {activeTab === 'parameters' && (
          <>
            <div className="rest-crafter-pane__table">
              {paramRows.length === 0 ? (
                <div className="rest-crafter-pane__note">
                  This operation documents no path or query parameters.
                </div>
              ) : paramRows.map(renderParamRow)}
            </div>
            <button className="rest-crafter-pane__add" onClick={addCustomParam}>
              + add parameter
            </button>
          </>
        )}

        {activeTab === 'body' && (
          <>
            {!takesBody(selection) && (
              <div className="rest-crafter-pane__note">
                {selection.method} {selection.path} does not support a request body
                {method !== selection.method && sendsBody(method)
                  && `, but anything typed here will be sent with ${method}`}.
              </div>
            )}
            <div className="rest-crafter-pane__editor" ref={editorRef} />
          </>
        )}
      </div>
    </div>
  );
}
