import React, { useEffect, useMemo, useRef } from 'react';
import { RefreshCw, ChevronRight, ChevronDown, ChevronsDownUp, ChevronsUpDown } from 'lucide-react';
import { ApiDocsContractVersion, ApiDocsOperationRow } from '../../main/types';
import { usePanelFocus } from '../dashboard/usePanelFocus';
import { filterServices, rowKeyOf, useRestStore, VersionRef } from '../stores/restStore';
import './ApiPickerPane.css';

interface SectionProps {
  label: string;
  entries: ApiDocsContractVersion[];
  open: boolean;
  onToggle: () => void;
  selected: VersionRef | null;
  onPick: (version: VersionRef) => void;
}

function VersionSection({ label, entries, open, onToggle, selected, onPick }: SectionProps): React.ReactElement | null {
  if (entries.length === 0) return null;
  return (
    <div className="api-picker-pane__section">
      <button className="api-picker-pane__section-header" onClick={onToggle}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className="api-picker-pane__section-label">{label}</span>
        <span className="api-picker-pane__count">{entries.length}</span>
      </button>
      {open && (
        <div className="api-picker-pane__section-body">
          {entries.map((entry) => {
            const isSelected = selected?.name === entry.name && selected?.type === entry.type;
            return (
              <button
                key={`${entry.type}-${entry.name}`}
                className={`api-picker-pane__row${isSelected ? ' api-picker-pane__row--selected' : ''}`}
                onClick={() => onPick({ name: entry.name, type: entry.type })}
              >
                {entry.name}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface OperationProps {
  row: ApiDocsOperationRow;
  /** The selected accept-version, or null when this row is not the selected one. */
  activeVersion: string | null | undefined;
  isSelected: boolean;
  onSelect: (acceptVersion: string | null) => void;
}

function OperationRowView({ row, activeVersion, isSelected, onSelect }: OperationProps): React.ReactElement {
  // Falls back to the newest accept-version, which is what the variant list is
  // sorted to put first.
  const active = isSelected && activeVersion !== undefined
    ? activeVersion
    : row.variants[0].acceptVersion;
  const variant = row.variants.find((v) => v.acceptVersion === active) ?? row.variants[0];

  return (
    <div className={`api-picker-pane__op${isSelected ? ' api-picker-pane__op--selected' : ''}`}>
      <button
        className="api-picker-pane__op-main"
        onClick={() => onSelect(active)}
        title={variant.summary}
      >
        <span className="api-picker-pane__method">{row.method}</span>
        <span className={`api-picker-pane__path${variant.deprecated ? ' api-picker-pane__path--deprecated' : ''}`}>
          {row.path}
        </span>
      </button>

      {row.variants.length > 1 && (
        <div className="api-picker-pane__versions">
          {row.variants.map((v) => (
            <button
              key={v.acceptVersion ?? 'none'}
              className={
                'api-picker-pane__version'
                + (v.acceptVersion === active ? ' api-picker-pane__version--active' : '')
                + (v.deprecated ? ' api-picker-pane__version--deprecated' : '')
              }
              onClick={() => onSelect(v.acceptVersion)}
              title={v.deprecated ? 'Deprecated version' : undefined}
            >
              v{v.acceptVersion ?? '—'}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** API Picker body — browse services, pick a contract version, pick an operation. */
export default function ApiPickerPane(): React.ReactElement {
  const rootRef = useRef<HTMLDivElement>(null);
  usePanelFocus(rootRef);

  // Subscribes to the whole store rather than field by field: this pane reads
  // every field, so a granular selector would gain nothing. Unlike sessionStore
  // there is no periodic poll here, so a change always means something the pane
  // actually renders.
  const {
    level, search, services, versions, operations, selectedService, selectedVersion,
    expanded, collapsedTags, selection, pendingSelection, loading, error,
    setSearch, toggleSection, toggleTag, setAllTagsCollapsed, loadServices, openService, openVersion,
    selectOperation, goToServices, goToVersions, refresh, restoreSelection,
  } = useRestStore();

  useEffect(() => {
    void loadServices();
  }, [loadServices]);

  // Re-resolve a selection that could not be restored earlier.
  //
  // Two triggers are needed. The pane is usually mounted long after startup —
  // Agent Smith is the default tab — so the `logged-in` broadcast has already
  // been and gone by the time this subscribes. Hence the mount-time check too.
  useEffect(() => {
    if (!pendingSelection) return;
    void window.dad.authStatus().then((status) => {
      if (status.state === 'logged-in') void restoreSelection();
    }).catch(() => { /* stays pending */ });
    return window.dad.onAuthStateChanged((status) => {
      if (status.state === 'logged-in') void restoreSelection();
    });
  }, [pendingSelection, restoreSelection]);

  const filtered = useMemo(() => filterServices(services, search), [services, search]);

  // Operations arrive already ordered by the contract's declared tag order, so
  // grouping by first encounter preserves it.
  const taggedGroups = useMemo(() => {
    const groups = new Map<string, ApiDocsOperationRow[]>();
    for (const row of operations) {
      const existing = groups.get(row.tag);
      if (existing) existing.push(row);
      else groups.set(row.tag, [row]);
    }
    return [...groups.entries()];
  }, [operations]);

  // Collapse-all unless everything already is, in which case expand.
  const anyExpanded = taggedGroups.some(([tag]) => collapsedTags[tag] !== true);

  const selectedRowKey = selection ? `${selection.method} ${selection.path}` : null;

  return (
    <div className="api-picker-pane" ref={rootRef}>
      <div className="api-picker-pane__bar">
        <div className="api-picker-pane__crumbs">
          <button className="api-picker-pane__crumb" onClick={goToServices}>SERVICES</button>
          {selectedService && (
            <>
              <span className="api-picker-pane__crumb-sep">/</span>
              <button className="api-picker-pane__crumb" onClick={goToVersions}>{selectedService}</button>
            </>
          )}
          {selectedVersion && level === 'operations' && (
            <>
              <span className="api-picker-pane__crumb-sep">/</span>
              <span className="api-picker-pane__crumb api-picker-pane__crumb--current">
                {selectedVersion.name}
                {selectedVersion.type !== 'RELEASE' && ` (${selectedVersion.type})`}
              </span>
            </>
          )}
        </div>
        <button
          className="btn btn--micro api-picker-pane__refresh"
          onClick={() => void refresh()}
          title="Refresh from API-docs"
          disabled={loading}
        >
          <RefreshCw size={12} />
        </button>
      </div>

      {level === 'services' && (
        <div className="api-picker-pane__search">
          <input
            className="api-picker-pane__search-input"
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && search) {
                // Stop here so Escape does not also reach any outer handler.
                e.preventDefault();
                e.stopPropagation();
                setSearch('');
              }
            }}
            placeholder="Search"
            spellCheck={false}
          />
        </div>
      )}

      {error && (
        <div className="api-picker-pane__error">
          <span>{error}</span>
          <button className="btn btn--micro" onClick={() => void refresh()}>RETRY</button>
        </div>
      )}

      {pendingSelection && !selection && (
        <div className="api-picker-pane__pending">
          {pendingSelection.method} {pendingSelection.path} — waiting for login
        </div>
      )}

      <div className="api-picker-pane__body">
        {loading && <div className="api-picker-pane__status">LOADING…</div>}

        {!loading && level === 'services' && (
          <>
            <div className="api-picker-pane__status">
              {search.trim()
                ? `${filtered.length} MATCH${filtered.length === 1 ? '' : 'ES'}`
                : `${services.length} SERVICES`}
            </div>
            {filtered.map((name) => (
              <button
                key={name}
                className={`api-picker-pane__row${name === selectedService ? ' api-picker-pane__row--selected' : ''}`}
                onClick={() => void openService(name)}
              >
                {name}
              </button>
            ))}
          </>
        )}

        {!loading && level === 'versions' && versions && (
          <>
            <VersionSection
              label="RELEASES" entries={versions.releases} open={expanded.releases}
              onToggle={() => toggleSection('releases')} selected={selectedVersion}
              onPick={(v) => void openVersion(v)}
            />
            <VersionSection
              label="PRE-RELEASES" entries={versions.prereleases} open={expanded.prereleases}
              onToggle={() => toggleSection('prereleases')} selected={selectedVersion}
              onPick={(v) => void openVersion(v)}
            />
            <VersionSection
              label="BRANCHES" entries={versions.branches} open={expanded.branches}
              onToggle={() => toggleSection('branches')} selected={selectedVersion}
              onPick={(v) => void openVersion(v)}
            />
          </>
        )}

        {!loading && level === 'operations' && (
          <>
            <div className="api-picker-pane__status api-picker-pane__status--row">
              <span>{operations.length} OPERATION{operations.length === 1 ? '' : 'S'}</span>
              {taggedGroups.length > 0 && (
                <button
                  className="btn btn--micro"
                  onClick={() => setAllTagsCollapsed(taggedGroups.map(([tag]) => tag), anyExpanded)}
                  title={anyExpanded ? 'Collapse all groups' : 'Expand all groups'}
                >
                  {anyExpanded ? <ChevronsDownUp size={12} /> : <ChevronsUpDown size={12} />}
                </button>
              )}
            </div>
            {taggedGroups.map(([tag, rows]) => {
              const collapsed = collapsedTags[tag] === true;
              return (
                <div className="api-picker-pane__section" key={tag}>
                  <button
                    className="api-picker-pane__section-header"
                    onClick={() => toggleTag(tag)}
                  >
                    {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                    <span className="api-picker-pane__section-label">{tag}</span>
                    <span className="api-picker-pane__count">{rows.length}</span>
                  </button>
                  {!collapsed && (
                    <div className="api-picker-pane__section-body">
                      {rows.map((row) => {
                        const key = rowKeyOf(row);
                        return (
                          <OperationRowView
                            key={key}
                            row={row}
                            activeVersion={selection?.acceptVersion}
                            isSelected={selectedRowKey === key}
                            onSelect={(v) => void selectOperation(row, v)}
                          />
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
