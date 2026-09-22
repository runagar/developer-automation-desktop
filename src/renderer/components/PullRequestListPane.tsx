import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { PrList, PrListId, PrListItem, PrReviewer } from '../../main/types';
import { useGitHubStore, sameRef } from '../stores/githubStore';
import ConfirmDialog from './ConfirmDialog';
import { relativeTime } from '../utils/relativeTime';
import { cn } from '../utils/cn';
import './PullRequestListPane.css';

const SECTIONS: { id: PrListId; label: string }[] = [
  { id: 'created', label: 'CREATED' },
  { id: 'reviewing', label: 'REVIEWING' },
  { id: 'listening', label: 'LISTENING' },
];

/** Reviewer state glyphs. `COMMENTED` and `DISMISSED` stay distinct. */
const REVIEWER_GLYPH: Record<PrReviewer['state'], string> = {
  APPROVED: '✓',
  CHANGES_REQUESTED: '✗',
  COMMENTED: '💬',
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
  return (
    <>
      {item.isDraft && <span className={chipClass('neutral')}>DRAFT</span>}
      {/* `warn` to match the viewer: a conflict is a state to fix, not a
          failed operation. */}
      {item.mergeable === 'CONFLICTING' && (
        <span className={chipClass('warn')}>Conflicts!</span>
      )}
      {/* GitHub computes mergeability lazily; UNKNOWN is "checking", never
          "conflicting". Short form: the list panel is six columns wide and the
          viewer carries the full wording. */}
      {item.mergeable === 'UNKNOWN' && (
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
  onSelect: (item: PrListItem) => void;
}

const Row = React.memo(function Row({ item, active, onSelect }: RowProps): React.ReactElement {
  return (
    <button
      className={cn('pull-request-list__row', active && 'pull-request-list__row--active')}
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
});

interface SectionProps {
  label: string;
  list: PrList;
  activeId: string | null;
  onSelect: (item: PrListItem) => void;
}

function Section({ label, list, activeId, onSelect }: SectionProps): React.ReactElement {
  // Collapse state is memory-only, matching the API Picker's category headers.
  const [open, setOpen] = useState(true);

  return (
    <div className="pull-request-list__section">
      <button className="pull-request-list__section-header" onClick={() => setOpen((v) => !v)}>
        <span className="pull-request-list__caret">{open ? '▾' : '▸'}</span>
        {label} ({list.items.length})
      </button>
      {open && (
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
      )}
    </div>
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
  const refreshLists = useGitHubStore((s) => s.refreshLists);
  const maybeRefreshLists = useGitHubStore((s) => s.maybeRefreshLists);
  const select = useGitHubStore((s) => s.select);
  const reloadDetail = useGitHubStore((s) => s.reloadDetail);

  const [confirmSwitch, setConfirmSwitch] = useState<PrListItem | null>(null);

  // A tab mounts lazily on first activation and is never unmounted, so mount
  // *is* "first tab activation".
  useEffect(() => {
    maybeRefreshLists();
    const onFocus = (): void => maybeRefreshLists();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [maybeRefreshLists]);

  const handleSelect = useCallback((item: PrListItem) => {
    const target = { owner: item.owner, repo: item.repo, number: item.number };
    // Already open *and* loaded — nothing to do. If it is selected but failed
    // to load, fall through so the click retries rather than doing nothing.
    if (sameRef(selection, target) && detail) return;
    // Replacing the open PR discards nothing on the server, but an in-progress
    // review is easy to forget about; confirm before moving away from it.
    if (detail?.summary.pendingReview && !sameRef(selection, target)) {
      setConfirmSwitch(item);
      return;
    }
    if (sameRef(selection, target)) {
      void reloadDetail();
      return;
    }
    select(target);
  }, [detail, reloadDetail, select, selection]);

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
            : `${lists.created.items.length} created · ${lists.reviewing.items.length} reviewing`
              + ` · ${lists.listening.items.length} listening`}
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
            list={lists[id]}
            activeId={activeId}
            onSelect={handleSelect}
          />
        ))}
      </div>

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
            select({
              owner: confirmSwitch.owner,
              repo: confirmSwitch.repo,
              number: confirmSwitch.number,
            });
            setConfirmSwitch(null);
          }}
        />
      )}
    </div>
  );
}
