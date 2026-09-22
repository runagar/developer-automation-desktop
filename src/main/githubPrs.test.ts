import { describe, it, expect } from 'vitest';
import { buildReviewers, toCheck, toCheckState, toMergeableState } from './githubPrs';

describe('toCheckState', () => {
  it('maps GitHub rollup states onto the four badges', () => {
    expect(toCheckState('SUCCESS')).toBe('SUCCESS');
    expect(toCheckState('FAILURE')).toBe('FAILURE');
    // ERROR is a distinct rollup state but means the same thing to a reviewer.
    expect(toCheckState('ERROR')).toBe('FAILURE');
    expect(toCheckState('PENDING')).toBe('PENDING');
    expect(toCheckState('EXPECTED')).toBe('PENDING');
  });

  it('treats "no checks configured" as NONE rather than failing', () => {
    expect(toCheckState(null)).toBe('NONE');
    expect(toCheckState(undefined)).toBe('NONE');
  });
});

describe('toMergeableState', () => {
  it('keeps UNKNOWN distinct from CONFLICTING', () => {
    // GitHub computes mergeability lazily and answers UNKNOWN while it works;
    // collapsing it would show "conflicting" for a healthy pull request.
    expect(toMergeableState('MERGEABLE')).toBe('MERGEABLE');
    expect(toMergeableState('CONFLICTING')).toBe('CONFLICTING');
    expect(toMergeableState('UNKNOWN')).toBe('UNKNOWN');
    expect(toMergeableState(undefined)).toBe('UNKNOWN');
  });
});

describe('buildReviewers', () => {
  it('marks only outstanding requests as requested', () => {
    // This flag is what the replace-set mutation is built from. Including a
    // past reviewer would re-request them and invalidate their approval.
    const reviewers = buildReviewers(
      [{ requestedReviewer: { __typename: 'User', login: 'bob' } }],
      [{ state: 'APPROVED', author: { login: 'ada' } }]
    );
    expect(reviewers.find((r) => r.name === 'ada')).toMatchObject({ state: 'APPROVED', requested: false });
    expect(reviewers.find((r) => r.name === 'bob')).toMatchObject({ state: 'PENDING_REQUEST', requested: true });
  });

  it('shows an outstanding re-request over a past review', () => {
    const reviewers = buildReviewers(
      [{ requestedReviewer: { __typename: 'User', login: 'ada' } }],
      [{ state: 'APPROVED', author: { login: 'ada' } }]
    );
    expect(reviewers).toHaveLength(1);
    expect(reviewers[0]).toMatchObject({ state: 'PENDING_REQUEST', requested: true });
  });

  it('renders a requested team by slug and flags it as a team', () => {
    const reviewers = buildReviewers(
      [{ requestedReviewer: { __typename: 'Team', slug: 'platform', combinedSlug: 'Nykredit/platform' } }],
      []
    );
    expect(reviewers[0]).toMatchObject({ name: 'platform', isTeam: true, isBot: false });
  });

  it('keeps the org-qualified slug for a team, which is what the API demands', () => {
    // `requestReviewsByLogin` takes `teamSlugs` in `org/team-slug` form and
    // rejects a bare slug — while the row displays the bare one.
    const reviewers = buildReviewers(
      [{ requestedReviewer: { __typename: 'Team', slug: 'platform', combinedSlug: 'Nykredit/platform' } }],
      []
    );
    expect(reviewers[0].requestKey).toBe('Nykredit/platform');
  });

  it('sends a user straight back by login', () => {
    const reviewers = buildReviewers([{ requestedReviewer: { __typename: 'User', login: 'ada' } }], []);
    expect(reviewers[0].requestKey).toBe('ada');
  });

  it('flags bots, which requestReviewsByLogin cannot accept', () => {
    const reviewers = buildReviewers([{ requestedReviewer: { __typename: 'Bot', login: 'dependabot' } }], []);
    expect(reviewers[0]).toMatchObject({ name: 'dependabot', isBot: true, isTeam: false });
  });

  it('keeps COMMENTED and DISMISSED distinct from "no action"', () => {
    const reviewers = buildReviewers([], [
      { state: 'COMMENTED', author: { login: 'ada' } },
      { state: 'DISMISSED', author: { login: 'bob' } },
    ]);
    expect(reviewers.map((r) => r.state)).toEqual(['COMMENTED', 'DISMISSED']);
  });

  it('ignores reviewers with no name and sorts the rest', () => {
    const reviewers = buildReviewers(
      [{ requestedReviewer: null }, { requestedReviewer: { __typename: 'User' } }],
      [{ state: 'APPROVED', author: null }, { state: 'APPROVED', author: { login: 'zoe' } }]
    );
    expect(reviewers.map((r) => r.name)).toEqual(['zoe']);
  });
});

describe('toCheck', () => {
  it('reads a GitHub Actions run from status + conclusion', () => {
    expect(toCheck({ __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }, 0))
      .toEqual({ name: 'build', state: 'SUCCESS', required: false });
  });

  it('reads an external integration from its single state field', () => {
    // StatusContext (Snyk, SonarQube) names itself `context`, not `name`.
    expect(toCheck({ __typename: 'StatusContext', context: 'security/snyk', state: 'SUCCESS', isRequired: true }, 0))
      .toEqual({ name: 'security/snyk', state: 'SUCCESS', required: true });
  });

  it('treats a run that has not finished as pending', () => {
    // `conclusion` is null until completion, which would otherwise read as a
    // failure.
    expect(toCheck({ __typename: 'CheckRun', name: 'slow', status: 'IN_PROGRESS', conclusion: null }, 0).state)
      .toBe('PENDING');
  });

  it('keeps SKIPPED distinct from SUCCESS', () => {
    // "Did not run" is not the same claim as "passed".
    expect(toCheck({ __typename: 'CheckRun', name: 'dependabot', status: 'COMPLETED', conclusion: 'SKIPPED' }, 0).state)
      .toBe('SKIPPED');
  });

  it('counts NEUTRAL as success and anything else as failure', () => {
    expect(toCheck({ __typename: 'CheckRun', name: 'n', status: 'COMPLETED', conclusion: 'NEUTRAL' }, 0).state)
      .toBe('SUCCESS');
    for (const c of ['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STALE']) {
      expect(toCheck({ __typename: 'CheckRun', name: 'n', status: 'COMPLETED', conclusion: c }, 0).state)
        .toBe('FAILURE');
    }
  });

  it('falls back to a positional name rather than rendering "undefined"', () => {
    expect(toCheck({ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }, 3).name)
      .toBe('check 4');
  });
});
