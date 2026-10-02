import React, { useEffect, useState } from 'react';
import { PrOwners, PrSummary } from '../../main/types';
import { useGitHubStore } from '../stores/githubStore';

interface Props {
  summary: PrSummary;
  onClose: () => void;
}

const NO_OWNERS: PrOwners = { teamKey: null, teamName: null, members: [] };

/**
 * Add, remove and re-request reviewers.
 *
 * `requestReviewsByLogin` has replace-set semantics, so every action submits
 * the complete desired set rather than a delta, and users and teams are kept
 * in separate collections because the mutation takes them separately.
 *
 * Adding someone not already on the pull request needs a source of
 * candidates. Three are offered, in descending order of usefulness: the
 * repository's **owners** — the team named by its `responsible_team` property
 * — then GitHub's `suggestedReviewers`, which infers a name or two from
 * blame, then a free-text login or `org/team` slug validated by the API on
 * submit. A full collaborator search is deliberately not built: the owning
 * team is a dozen people, while `collaborators` is hundreds and needs push
 * permission the viewer may not have.
 */
export default function ReviewersMenu({ summary, onClose }: Props): React.ReactElement {
  const run = useGitHubStore((s) => s.run);
  const busy = useGitHubStore((s) => s.busy);
  const patchSummary = useGitHubStore((s) => s.patchSummary);
  const reloadDetail = useGitHubStore((s) => s.reloadDetail);
  const syncListRow = useGitHubStore((s) => s.syncListRow);

  const [entry, setEntry] = useState('');
  const [owners, setOwners] = useState<PrOwners | null>(null);
  const [ownersFailed, setOwnersFailed] = useState(false);

  /**
   * Fetched when the menu opens rather than with the pull request: it is two
   * extra round trips that only matter once this popover is on screen, and
   * the main process caches the answer per repository.
   *
   * Failure is reported in place and never through `run`: this is a read that
   * happened to fail, not a rejected action, and routing it into `actionError`
   * would blame the user's last click.
   */
  useEffect(() => {
    let cancelled = false;
    setOwners(null);
    setOwnersFailed(false);
    window.dad
      .githubGetOwners({ owner: summary.owner, repo: summary.repo, number: summary.number })
      .then((result) => { if (!cancelled) setOwners(result); })
      .catch(() => { if (!cancelled) setOwnersFailed(true); });
    return () => { cancelled = true; };
  }, [summary.owner, summary.repo, summary.number]);

  /**
   * The current *desired* set, which is what a replace-set mutation must be
   * built from.
   *
   * Only reviewers with an outstanding request belong here. `summary.reviewers`
   * also contains people who already approved, commented or were dismissed;
   * submitting those would create a fresh review request for each of them and
   * invalidate their existing review state. Bots are excluded because
   * `requestReviewsByLogin` rejects the whole call when given one.
   */
  const requested = summary.reviewers.filter((r) => r.requested && !r.isBot);
  // `requestKey`, not `name`: a team must go back as `org/team-slug`, which is
  // not what the row displays.
  const users = requested.filter((r) => !r.isTeam).map((r) => r.requestKey);
  const teams = requested.filter((r) => r.isTeam).map((r) => r.requestKey);

  const apply = async (nextUsers: string[], nextTeams: string[]): Promise<void> => {
    const reviewers = await run(() => window.dad.githubSetReviewers(summary.id, nextUsers, nextTeams));
    if (reviewers !== null) {
      patchSummary({ reviewers });
      // Ahead of the reload, so the list row does not lag a round trip.
      syncListRow({ ...summary, reviewers });
      await reloadDetail();
    }
  };

  const remove = (key: string, isTeam: boolean): void => {
    void apply(
      isTeam ? users : users.filter((u) => u !== key),
      isTeam ? teams.filter((t) => t !== key) : teams
    );
  };

  const add = (raw: string): void => {
    const value = raw.trim().replace(/^@/, '');
    if (!value) return;
    setEntry('');
    // `org/team` is both how a team is named here and exactly what the
    // mutation expects — the org must NOT be stripped.
    if (value.includes('/')) {
      if (teams.includes(value)) return;
      void apply(users, [...teams, value]);
      return;
    }
    if (users.includes(value)) return;
    void apply([...users, value], teams);
  };

  /**
   * Re-requesting is the same replace-set call with the person still in it:
   * submitting an existing reviewer clears their previous review state.
   */
  const reRequest = (key: string, isTeam: boolean): void => {
    void apply(
      isTeam ? users : [...new Set([...users, key])],
      isTeam ? [...new Set([...teams, key])] : teams
    );
  };

  /**
   * The free-text field doubles as the owner filter: a dozen logins is too
   * many to scan but far too few to deserve a second search box, and typing
   * is what the user reaches for either way.
   */
  const filter = entry.trim().replace(/^@/, '').toLowerCase();

  const matchesFilter = (login: string, name: string | null): boolean =>
    !filter
    || login.toLowerCase().includes(filter)
    || (name ?? '').toLowerCase().includes(filter);

  /**
   * Already on the pull request, or the author.
   *
   * GitHub refuses a review request from the pull request's own author, so
   * offering them is offering a button that can only fail.
   */
  const alreadyOffered = (login: string): boolean =>
    login === summary.author
    || summary.reviewers.some((r) => !r.isTeam && r.name === login);

  const { teamKey, teamName, members } = owners ?? NO_OWNERS;

  const ownerTeam = teamKey !== null
    && !teams.includes(teamKey)
    && matchesFilter(teamKey, teamName)
    ? teamKey
    : null;

  const ownerMembers = members
    .filter((m) => !alreadyOffered(m.login))
    .filter((m) => matchesFilter(m.login, m.name));

  const suggestions = summary.suggestedReviewers
    .filter((s) => !alreadyOffered(s))
    .filter((s) => matchesFilter(s, null));

  return (
    <div className="pr-reviewers" onMouseDown={(e) => e.stopPropagation()}>
      <div className="pr-reviewers__header">
        REVIEWERS
        <button className="btn btn--micro" onClick={onClose}>✕</button>
      </div>

      {summary.reviewers.length === 0 && <div className="pr-reviewers__none">none requested</div>}

      {summary.reviewers.map((reviewer) => (
        <div key={`${reviewer.isTeam}-${reviewer.name}`} className="pr-reviewers__row">
          <span className="pr-reviewers__name">
            {reviewer.isTeam ? `@${reviewer.name}` : reviewer.name}
          </span>
          <span className="pr-reviewers__state">{reviewer.state.replace(/_/g, ' ').toLowerCase()}</span>
          {/* A bot cannot be sent through requestReviewsByLogin at all, so it
              is shown but not editable. */}
          {!reviewer.isBot && (
            <>
              <button
                className="btn btn--micro"
                disabled={busy}
                title="Re-request review"
                onClick={() => reRequest(reviewer.requestKey, reviewer.isTeam)}
              >
                ↻
              </button>
              <button
                className="btn btn--micro btn--danger"
                disabled={busy || !reviewer.requested}
                title={reviewer.requested ? 'Remove reviewer' : 'No outstanding request to remove'}
                onClick={() => remove(reviewer.requestKey, reviewer.isTeam)}
              >
                ✕
              </button>
            </>
          )}
        </div>
      ))}

      <input
        className="pr-reviewers__input"
        value={entry}
        placeholder="filter, or login / org/team + Enter"
        disabled={busy}
        onChange={(e) => setEntry(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); add(entry); }
          if (e.key === 'Escape') { e.preventDefault(); onClose(); }
        }}
      />

      {ownersFailed && <div className="pr-reviewers__none">owners unavailable</div>}
      {owners === null && !ownersFailed && <div className="pr-reviewers__none">loading owners…</div>}

      {(ownerTeam !== null || ownerMembers.length > 0) && (
        <div className="pr-reviewers__owners">
          <span className="pr-reviewers__suggest-label">
            OWNERS{teamName ? ` · ${teamName}` : ''}
          </span>
          <div className="pr-reviewers__suggestions">
            {ownerTeam !== null && (
              <button
                className="btn btn--micro"
                disabled={busy}
                title="Request the whole owning team"
                onClick={() => add(ownerTeam)}
              >
                @{ownerTeam}
              </button>
            )}
            {ownerMembers.map((member) => (
              <button
                key={member.login}
                className="btn btn--micro"
                disabled={busy}
                title={member.name ?? member.login}
                onClick={() => add(member.login)}
              >
                {member.login}
              </button>
            ))}
          </div>
        </div>
      )}

      {suggestions.length > 0 && (
        <div className="pr-reviewers__suggestions">
          <span className="pr-reviewers__suggest-label">SUGGESTED</span>
          {suggestions.map((name) => (
            <button key={name} className="btn btn--micro" disabled={busy} onClick={() => add(name)}>
              {name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
