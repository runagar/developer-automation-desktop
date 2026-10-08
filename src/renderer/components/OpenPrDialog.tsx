import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PrCandidate, PrCandidateResult, WorkspaceEntry } from '../../main/types';
import { OPEN_PR_OWNER, orderCandidates } from '../../main/githubPrLists';
import { useGitHubStore, pickWorkspace } from '../stores/githubStore';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { useEscape } from '../hooks/useEscape';
import { useTopLayer } from './dropdown';
import WorkspacePicker from './WorkspacePicker';
import BranchPair from './BranchPair';
import { absoluteTime } from '../utils/absoluteTime';
import './OpenPrDialog.css';

type Which = 'open' | 'closed';

interface Load {
  repo: string | null;
  loading: boolean;
  result: PrCandidateResult | null;
  error: string | null;
}

const IDLE: Load = { repo: null, loading: false, result: null, error: null };

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [tabindex="0"]';

interface Props {
  onClose: () => void;
  onPick: (candidate: PrCandidate) => void;
}

interface RowProps {
  candidate: PrCandidate;
  added: boolean;
  onPick: (candidate: PrCandidate) => void;
}

function CandidateRow({ candidate, added, onPick }: RowProps): React.ReactElement {
  return (
    <button className="open-pr-dialog__row" title={candidate.title} onClick={() => onPick(candidate)}>
      <BranchPair
        head={candidate.headRefName}
        base={candidate.baseRefName}
        className="open-pr-dialog__branches"
      />
      <span className="open-pr-dialog__title">#{candidate.number} {candidate.title}</span>
      {candidate.state === 'OPEN' && candidate.isDraft && (
        <span className="state-chip state-chip--neutral">DRAFT</span>
      )}
      {candidate.state !== 'OPEN' && (
        <span className="state-chip state-chip--neutral">{candidate.state}</span>
      )}
      {added && <span className="state-chip state-chip--neutral">ADDED</span>}
      <span className="open-pr-dialog__meta">
        {candidate.author ?? 'ghost'} {absoluteTime(candidate.createdAt)}
      </span>
    </button>
  );
}

export default function OpenPrDialog({ onClose, onPick }: Props): React.ReactElement {
  const groups = useWorkspaceStore((s) => s.groups);
  const rememberedKey = useGitHubStore((s) => s.openPrWorkspace);
  const setRemembered = useGitHubStore((s) => s.setOpenPrWorkspace);
  const otherEntries = useGitHubStore((s) => s.otherEntries);

  const workspace = pickWorkspace(groups, rememberedKey);
  const repo = workspace?.repo ?? null;

  const [showDrafts, setShowDrafts] = useState(false);
  const [showClosed, setShowClosed] = useState(false);
  const [loads, setLoads] = useState<Record<Which, Load>>({ open: IDLE, closed: IDLE });
  const generations = useRef<Record<Which, number>>({ open: 0, closed: 0 });

  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<Element | null>(document.activeElement);

  useTopLayer(overlayRef, { anchorToParent: false });
  useEscape(true, onClose);

  useEffect(() => {
    const opener = openerRef.current;
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.ctrlKey || e.altKey || e.metaKey) return;

      const focusables = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE))
        .filter((node) => node.getClientRects().length > 0);
      if (focusables.length === 0) return;

      const idx = focusables.indexOf(document.activeElement as HTMLElement);
      const next = idx === -1
        ? (e.shiftKey ? focusables[focusables.length - 1] : focusables[0])
        : focusables[(idx + (e.shiftKey ? -1 : 1) + focusables.length) % focusables.length];
      next.focus();
    }

    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, []);

  const load = useCallback(async (target: string, which: Which) => {
    const generation = ++generations.current[which];
    setLoads((prev) => ({ ...prev, [which]: { repo: target, loading: true, result: null, error: null } }));
    try {
      const result = await window.dad.githubListRepoPullRequests(target, which);
      if (generation !== generations.current[which]) return;
      setLoads((prev) => ({ ...prev, [which]: { repo: target, loading: false, result, error: null } }));
    } catch (err) {
      if (generation !== generations.current[which]) return;
      setLoads((prev) => ({
        ...prev,
        [which]: { repo: target, loading: false, result: null, error: (err as Error).message },
      }));
    }
  }, []);

  useEffect(() => {
    if (repo) void load(repo, 'open');
  }, [repo, load]);

  const closedRepo = loads.closed.repo;
  useEffect(() => {
    if (repo && showClosed && closedRepo !== repo) void load(repo, 'closed');
  }, [repo, showClosed, closedRepo, load]);

  const retry = (): void => {
    if (!repo) return;
    void load(repo, 'open');
    if (showClosed) void load(repo, 'closed');
  };

  const selectWorkspace = (next: WorkspaceEntry): void => {
    setRemembered(next.key);
  };

  const open = loads.open.repo === repo ? loads.open : IDLE;
  const closed = loads.closed.repo === repo ? loads.closed : IDLE;
  const openFound = open.result?.kind === 'found' ? open.result : null;
  const closedFound = closed.result?.kind === 'found' ? closed.result : null;
  const notFound = open.result?.kind === 'not-found';

  const candidates = useMemo(
    () => orderCandidates(openFound?.candidates ?? [], closedFound?.candidates ?? null, { showDrafts, showClosed }),
    [openFound, closedFound, showDrafts, showClosed]
  );
  const added = useMemo(() => new Set(otherEntries.map((e) => e.id)), [otherEntries]);

  return (
    <div
      ref={overlayRef}
      className="dialog-overlay"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={dialogRef}
        className="open-pr-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Open pull request"
        data-focus-trap=""
      >
        <div className="open-pr-dialog__title-bar">OPEN PULL REQUEST</div>

        <div className="open-pr-dialog__controls">
          <span className="open-pr-dialog__label">REPOSITORY</span>
          <WorkspacePicker groups={groups} selected={workspace} onSelect={selectWorkspace} autoFocus />
          <label className="open-pr-dialog__toggle">
            <input type="checkbox" checked={showDrafts} onChange={(e) => setShowDrafts(e.target.checked)} />
            show drafts
          </label>
          <label className="open-pr-dialog__toggle">
            <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />
            show closed
          </label>
        </div>

        {(open.error || closed.error) && (
          <div className="panel-error">
            {open.error ?? closed.error}
            <button className="btn btn--micro panel-error__retry" onClick={retry}>RETRY</button>
          </div>
        )}

        <div className="open-pr-dialog__list">
          {!workspace && <div className="open-pr-dialog__notice">No workspaces registered</div>}
          {open.loading && <div className="open-pr-dialog__notice open-pr-dialog__notice--loading">LOADING…</div>}
          {notFound && (
            <div className="open-pr-dialog__notice open-pr-dialog__notice--warn">
              Not a {OPEN_PR_OWNER} GitHub repository
            </div>
          )}
          {openFound && (
            <>
              {candidates.length === 0 && !closed.loading && (
                <div className="open-pr-dialog__notice">nothing here</div>
              )}
              {candidates.map((candidate) => (
                <CandidateRow
                  key={candidate.id}
                  candidate={candidate}
                  added={added.has(candidate.id)}
                  onPick={onPick}
                />
              ))}
              {showClosed && closed.loading && (
                <div className="open-pr-dialog__notice open-pr-dialog__notice--loading">LOADING…</div>
              )}
              {openFound.truncated && (
                <div className="open-pr-dialog__notice open-pr-dialog__notice--warn">
                  Only the newest open pull requests are shown
                </div>
              )}
            </>
          )}
        </div>

        <div className="open-pr-dialog__buttons">
          <button className="btn btn--micro" onClick={onClose}>CANCEL</button>
        </div>
      </div>
    </div>
  );
}
