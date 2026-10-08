import React, { useCallback, useMemo, useState } from 'react';
import { RefreshCw, MessageSquareText } from 'lucide-react';
import {
  PrCandidate, PrList, PrListId, PrListItem, PrOtherEntry, PrRef, PrReviewer,
} from '../../main/types';
import { useGitHubStore, sameRef } from '../stores/githubStore';
import ConfirmDialog from './ConfirmDialog';
import BranchPair from './BranchPair';
import OpenPrDialog from './OpenPrDialog';
import { relativeTime } from '../utils/relativeTime';
import { cn } from '../utils/cn';
import './PullRequestListPane.css';

const SECTIONS: { id: PrListId; label: string }[] = [
  { id: 'created', label: 'CREATED' },
  { id: 'reviewing', label: 'REVIEWING' },
  { id: 'other', label: 'OTHER' },
];

/**
 * Reviewer state glyphs. `COMMENTED` and `DISMISSED` stay distinct.
 *
 * Text glyphs where Roboto Mono has one. `COMMENTED` is an icon because the
 * speech-balloon emoji it used to be is outside the font and rendered as a
 * tofu box.
 */
const REVIEWER_GLYPH: Record<PrReviewer['state'], React.ReactNode> = {
  APPROVED: '✓',
  CHANGES_REQUESTED: '✗',
  COMMENTED: <MessageSquareText size={11} />,
  DISMISSED: '⊘',
  PENDING_REQUEST: '·',
};

function ReviewerChip({ reviewer }: { reviewer: PrReviewer }): React.ReactElement {
  return (
    <span
      className={cn('pull-request-list__reviewer', `pull-request-list__reviewer--${reviewer.state.toLowerCase()}`)}
      title={`${reviewer.isTeam ? 'team ' : ''}${reviewer.name} — ${reviewer.state.replace(/_/g, ' ').toLowerCase()}`}
    >
      <span className="pull-request-list__reviewer-glyph">{REVIEWER_GLYPH[reviewer.state]}</span>
      {reviewer.isTeam ? `@${reviewer.name}` : reviewer.name}
    </span>
  );
}

/** Shared filled-marker classes; see `.state-chip` in pipboy.css. */
function chipClass(tone: 'ok' | 'warn' | 'checking' | 'error' | 'neutral'): string {
  return `state-chip state-chip--${tone}`;
}

function Badges({ item }: { item: PrListItem }): React.ReactElement {
  const open = item.state === 'OPEN';
  return (
    <>
      {!open && <span className={chipClass('neutral')}>{item.state}</span>}
      {open && item.isDraft && <span className={chipClass('neutral')}>DRAFT</span>}
      {/* `warn` to match the viewer: a conflict is a state to fix, not a
          failed operation. */}
      {open && item.mergeable === 'CONFLICTING' && (
        <span className={chipClass('warn')}>Conflicts!</span>
      )}
      {/* GitHub computes mergeability lazily; UNKNOWN is "checking", never
          "conflicting". Short form: the list panel is six columns wide and the
          viewer carries the full wording. */}
      {open && item.mergeable === 'UNKNOWN' && (
        <span className={chipClass('checking')}>Checking…</span>
      )}
      {item.checks !== 'NONE' && (
        <span className={chipClass(
          item.checks === 'SUCCESS' ? 'ok' : item.checks === 'FAILURE' ? 'warn' : 'checking'
        )}>
          {item.checks === 'SUCCESS' ? 'Checks ✓' : item.checks === 'FAILURE' ? 'Checks ✗' : 'Checks …'}
        </span>
      )}
    </>
  );
}

interface RowProps {
  item: PrListItem;
  active: boolean;
  onSelect: (ref: PrRef) => void;
  onRemove?: (id: string) => void;
}

const Row = React.memo(function Row({ item, active, onSelect, onRemove }: RowProps): React.ReactElement {
  const row = (
    <button
      className={cn(
        'pull-request-list__row',
        active && 'pull-request-list__row--active',
        onRemove && 'pull-request-list__row--removable'
      )}
      onClick={() => onSelect(item)}
      title={item.title}
    >
      <span className="pull-request-list__title">
        <span className="pull-request-list__number">#{item.number}</span>
        {item.title}
      </span>
      <span className="pull-request-list__repo">
        {item.nameWithOwner}
        <span className="pull-request-list__updated">{relativeTime(item.updatedAt)}</span>
      </span>
      <BranchPair
        head={item.headRefName}
        base={item.baseRefName}
        className="pull-request-list__branches"
      />
      <span className="pull-request-list__meta">
        <Badges item={item} />
      </span>
      {item.reviewers.length > 0 && (
        <span className="pull-request-list__reviewers">
          {item.reviewers.map((r) => <ReviewerChip key={`${r.isTeam}-${r.name}`} reviewer={r} />)}
        </span>
      )}
    </button>
  );

  if (!onRemove) return row;
  return (
    <div className="pull-request-list__row-wrap">
      {row}
      <RemoveButton id={item.id} onRemove={onRemove} />
    </div>
  );
});

function RemoveButton({ id, onRemove }: { id: string; onRemove: (id: string) => void }): React.ReactElement {
  return (
    <button
      className="btn btn--micro btn--danger pull-request-list__remove"
      title="Remove from OTHER"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onRemove(id)}
    >
      ✕
    </button>
  );
}

interface EntryRowProps {
  entry: PrOtherEntry;
  unavailable: boolean;
  active: boolean;
  onSelect: (ref: PrRef) => void;
  onRemove: (id: string) => void;
}

/** An `OTHER` entry with no fetched row: not loaded yet, or gone from GitHub. */
function EntryRow({ entry, unavailable, active, onSelect, onRemove }: EntryRowProps): React.ReactElement {
  const label = (
    <span className="pull-request-list__title">
      <span className="pull-request-list__number">#{entry.number}</span>
      {entry.owner}/{entry.repo}
      {unavailable && ' (unavailable)'}
    </span>
  );

  return (
    <div className="pull-request-list__row-wrap">
      {unavailable ? (
        <div className="pull-request-list__row pull-request-list__row--removable pull-request-list__row--unavailable">
          {label}
        </div>
      ) : (
        <button
          className={cn(
            'pull-request-list__row',
            'pull-request-list__row--removable',
            active && 'pull-request-list__row--active'
          )}
          onClick={() => onSelect(entry)}
        >
          {label}
        </button>
      )}
      <RemoveButton id={entry.id} onRemove={onRemove} />
    </div>
  );
}

interface SectionProps {
  label: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  action?: React.ReactNode;
  children: React.ReactNode;
}

function Section({ label, count, open, onToggle, action, children }: SectionProps): React.ReactElement {
  return (
    <div className="pull-request-list__section">
      <div className="pull-request-list__section-header">
        <button className="pull-request-list__section-toggle" onClick={onToggle}>
          <span className="pull-request-list__caret">{open ? '▾' : '▸'}</span>
          {label} ({count})
        </button>
        {action}
      </div>
      {open && children}
    </div>
  );
}

interface SearchedListProps {
  list: PrList;
  activeId: string | null;
  onSelect: (ref: PrRef) => void;
}

function SearchedList({ list, activeId, onSelect }: SearchedListProps): React.ReactElement {
  return (
    <>
      {list.items.length === 0 && <div className="pull-request-list__none">nothing here</div>}
      {list.items.map((item) => (
        <Row key={item.id} item={item} active={item.id === activeId} onSelect={onSelect} />
      ))}
      {list.more > 0 && (
        <div className="pull-request-list__more">
          {list.moreIsApproximate ? `≈${list.more} more` : `${list.more} more`}
        </div>
      )}
    </>
  );
}

interface OtherListProps {
  list: PrList;
  entries: PrOtherEntry[];
  unavailable: string[];
  activeId: string | null;
  onSelect: (ref: PrRef) => void;
  onRemove: (id: string) => void;
}

function OtherList({ list, entries, unavailable, activeId, onSelect, onRemove }: OtherListProps): React.ReactElement {
  const entryIds = new Set(entries.map((e) => e.id));
  const rows = list.items.filter((item) => entryIds.has(item.id));
  const rowIds = new Set(rows.map((item) => item.id));
  const unavailableIds = new Set(unavailable);

  return (
    <>
      {entries.length === 0 && <div className="pull-request-list__none">nothing here</div>}
      {rows.map((item) => (
        <Row key={item.id} item={item} active={item.id === activeId} onSelect={onSelect} onRemove={onRemove} />
      ))}
      {entries.filter((e) => !rowIds.has(e.id)).map((entry) => (
        <EntryRow
          key={entry.id}
          entry={entry}
          unavailable={unavailableIds.has(entry.id)}
          active={entry.id === activeId}
          onSelect={onSelect}
          onRemove={onRemove}
        />
      ))}
    </>
  );
}

export default function PullRequestListPane(): React.ReactElement {
  // Granular selectors: this pane must not re-render when the viewer's diff
  // or composer state changes.
  const lists = useGitHubStore((s) => s.lists);
  const loading = useGitHubStore((s) => s.listsLoading);
  const error = useGitHubStore((s) => s.listsError);
  const selection = useGitHubStore((s) => s.selection);
  const detail = useGitHubStore((s) => s.detail);
  const otherEntries = useGitHubStore((s) => s.otherEntries);
  const otherUnavailable = useGitHubStore((s) => s.otherUnavailable);
  const refreshLists = useGitHubStore((s) => s.refreshLists);
  const select = useGitHubStore((s) => s.select);
  const reloadDetail = useGitHubStore((s) => s.reloadDetail);
  const addOther = useGitHubStore((s) => s.addOther);
  const removeOther = useGitHubStore((s) => s.removeOther);

  const [confirmSwitch, setConfirmSwitch] = useState<PrRef | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<PrOtherEntry | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<PrListId, boolean>>({
    created: false, reviewing: false, other: false,
  });

  const handleSelect = useCallback((item: PrRef) => {
    const target = { owner: item.owner, repo: item.repo, number: item.number };
    // Already open *and* loaded — nothing to do. If it is selected but failed
    // to load, fall through so the click retries rather than doing nothing.
    if (sameRef(selection, target) && detail) return;
    // Replacing the open PR discards nothing on the server, but an in-progress
    // review is easy to forget about; confirm before moving away from it.
    if (detail?.summary.pendingReview && !sameRef(selection, target)) {
      setConfirmSwitch(target);
      return;
    }
    if (sameRef(selection, target)) {
      void reloadDetail();
      return;
    }
    select(target);
  }, [detail, reloadDetail, select, selection]);

  const handleRemove = useCallback((id: string) => {
    const state = useGitHubStore.getState();
    const entry = state.otherEntries.find((e) => e.id === id);
    if (!entry) return;
    const isOpen = sameRef(state.selection, entry) || state.detail?.summary.id === id;
    if (isOpen && state.detail?.summary.pendingReview) {
      setConfirmRemove(entry);
      return;
    }
    removeOther(id);
  }, [removeOther]);

  const handlePick = useCallback((candidate: PrCandidate) => {
    setDialogOpen(false);
    addOther(candidate);
    setCollapsed((c) => ({ ...c, other: false }));
    handleSelect(candidate);
  }, [addOther, handleSelect]);

  const closeDialog = useCallback(() => setDialogOpen(false), []);

  const toggle = (id: PrListId): void => setCollapsed((c) => ({ ...c, [id]: !c[id] }));

  const counts = useMemo<Record<PrListId, number>>(() => ({
    created: lists.created.items.length,
    reviewing: lists.reviewing.items.length,
    other: otherEntries.length,
  }), [lists, otherEntries]);

  const activeId = detail?.summary.id ?? null;

  return (
    <div className="pull-request-list">
      <div className="pull-request-list__toolbar">
        {/* The counts and the loading notice share one slot: the notice is
            transient and the counts are stale while it shows, so displaying
            both at once would assert a total that is about to change. */}
        <span className={cn('pull-request-list__status', loading && 'pull-request-list__status--loading')}>
          {loading
            ? 'LOADING…'
            : `${counts.created} created · ${counts.reviewing} reviewing · ${counts.other} other`}
        </span>
        {/* Same icon as the PR viewer and the API Picker. */}
        <button
          className="btn btn--micro pull-request-list__refresh"
          onClick={() => void refreshLists(true)}
          disabled={loading}
          title="Refresh"
        >
          <RefreshCw size={12} />
        </button>
      </div>

      {error && (
        <div className="panel-error">
          {error}
          <button className="btn btn--micro panel-error__retry" onClick={() => void refreshLists(true)}>
            RETRY
          </button>
        </div>
      )}

      <div className="pull-request-list__body">
        {SECTIONS.map(({ id, label }) => (
          <Section
            key={id}
            label={label}
            count={counts[id]}
            open={!collapsed[id]}
            onToggle={() => toggle(id)}
            action={id === 'other' && (
              <button
                className="btn btn--micro pull-request-list__section-action"
                onClick={() => setDialogOpen(true)}
              >
                + OPEN PR
              </button>
            )}
          >
            {id === 'other' ? (
              <OtherList
                list={lists.other}
                entries={otherEntries}
                unavailable={otherUnavailable}
                activeId={activeId}
                onSelect={handleSelect}
                onRemove={handleRemove}
              />
            ) : (
              <SearchedList list={lists[id]} activeId={activeId} onSelect={handleSelect} />
            )}
          </Section>
        ))}
      </div>

      {dialogOpen && <OpenPrDialog onClose={closeDialog} onPick={handlePick} />}

      {confirmSwitch && (
        <ConfirmDialog
          message="Leave the review in progress?"
          detail={
            'You have unsubmitted review comments. They stay on GitHub as a pending review, '
            + `but opening #${confirmSwitch.number} will close this view of them.`
          }
          confirmLabel="OPEN ANYWAY"
          onCancel={() => setConfirmSwitch(null)}
          onConfirm={() => {
            select(confirmSwitch);
            setConfirmSwitch(null);
          }}
        />
      )}

      {confirmRemove && (
        <ConfirmDialog
          message="Leave the review in progress?"
          detail={
            'You have unsubmitted review comments. They stay on GitHub as a pending review, '
            + `but removing #${confirmRemove.number} will close this view of them.`
          }
          confirmLabel="REMOVE ANYWAY"
          onCancel={() => setConfirmRemove(null)}
          onConfirm={() => {
            removeOther(confirmRemove.id);
            setConfirmRemove(null);
          }}
        />
      )}
    </div>
  );
}
