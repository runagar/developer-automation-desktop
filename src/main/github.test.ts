import { describe, it, expect, vi } from 'vitest';
import { execFile } from 'child_process';
import {
  GitHubAuthError, GitHubError, GitHubRateLimitError, GitHubUnavailableError,
  __test__, ghGraphql, githubErrorMessage,
} from './github';

vi.mock('child_process', () => ({ execFile: vi.fn() }));

const { mapExecError, pageUrl } = __test__;

describe('mapExecError', () => {
  it('maps a missing binary to an install hint', () => {
    const err = mapExecError({ stderr: '', code: 'ENOENT' });
    expect(err).toBeInstanceOf(GitHubUnavailableError);
    expect(err.message).toContain('setup.sh');
  });

  it('maps an unauthenticated CLI to the remediation command', () => {
    const err = mapExecError({ stderr: 'To get started with GitHub CLI, please run: gh auth login', code: '1' });
    expect(err).toBeInstanceOf(GitHubAuthError);
    expect(err.message).toContain('gh auth login');
  });

  it('maps a 401 and bad credentials to an auth error', () => {
    expect(mapExecError({ stderr: 'HTTP 401: Bad credentials', code: '1' })).toBeInstanceOf(GitHubAuthError);
    expect(mapExecError({ stderr: 'gh: Requires authentication', code: '1' })).toBeInstanceOf(GitHubAuthError);
  });

  it('maps an explicit rate-limit message to a rate-limit error', () => {
    const err = mapExecError({ stderr: 'API rate limit exceeded for user ID 1', code: '1' });
    expect(err).toBeInstanceOf(GitHubRateLimitError);
  });

  it('does NOT assume every 403 is rate limiting', () => {
    // A 403 is also SSO enforcement, an archived repository and a protected
    // branch. Telling the user to wait forty minutes for something that will
    // never succeed is worse than showing them what GitHub said.
    const err = mapExecError({
      stderr: 'HTTP 403: Resource protected by organization SAML enforcement',
      code: '1',
    });
    expect(err).toBeInstanceOf(GitHubError);
    expect(err).not.toBeInstanceOf(GitHubRateLimitError);
    expect(err.message).toContain('SAML');
  });

  it('keeps only the first non-empty line of stderr', () => {
    const err = mapExecError({ stderr: '\n\nHTTP 422: Validation failed\nsee docs\n', code: '1' });
    expect(err.message).toBe('HTTP 422: Validation failed');
  });

  it('falls back to a generic message when stderr is empty', () => {
    expect(mapExecError({ stderr: '   ', code: '1' }).message).toBe('GitHub request failed');
  });
});

describe('GitHubRateLimitError', () => {
  it('renders the reset time when it is known', () => {
    const at = new Date('2026-09-21T10:30:00Z').getTime();
    expect(new GitHubRateLimitError(at).message).toMatch(/Rate limited — retry at \d{2}:\d{2}/);
  });

  it('degrades gracefully when the reset time could not be read', () => {
    expect(new GitHubRateLimitError(null).message).toBe('Rate limited — retry shortly');
  });
});

describe('githubErrorMessage', () => {
  it('passes typed GitHub errors through verbatim', () => {
    expect(githubErrorMessage(new GitHubError('HTTP 404: Not Found'))).toBe('HTTP 404: Not Found');
    expect(githubErrorMessage(new GitHubUnavailableError())).toContain('GitHub CLI not found');
  });

  it('handles a non-Error value without producing "undefined"', () => {
    expect(githubErrorMessage(null)).toBe('GitHub request failed');
    expect(githubErrorMessage({})).toBe('GitHub request failed');
    expect(githubErrorMessage(new Error('boom'))).toBe('boom');
  });
});

describe('pageUrl', () => {
  it('appends pagination with the right separator', () => {
    expect(pageUrl('repos/o/r/pulls/1/files', 2)).toBe('repos/o/r/pulls/1/files?per_page=100&page=2');
    expect(pageUrl('repos/o/r/compare/a...b?x=1', 3)).toBe('repos/o/r/compare/a...b?x=1&per_page=100&page=3');
  });
});

describe('ghGraphql', () => {
  /**
   * `gh api graphql` exits non-zero on a top-level GraphQL error and still
   * prints the envelope, so these assert the envelope is read first.
   */
  function mockGh(stdout: string, failure: Error | null, stderr = ''): void {
    vi.mocked(execFile).mockImplementation(((
      _cmd: unknown, _args: unknown, _opts: unknown, cb: (e: unknown, o: string, s: string) => void
    ) => {
      cb(failure, stdout, stderr);
      return { stdin: { end: () => undefined } };
    }) as never);
  }

  it('keeps the GraphQL error type when gh exits non-zero', async () => {
    // Given a personal repository asked for custom property values: GitHub
    // answers with data *and* a typed top-level error, and gh exits 1.
    mockGh(
      JSON.stringify({
        data: { repository: { repositoryCustomPropertyValues: null } },
        errors: [{
          type: 'NOT_ORG_OWNED_REPO',
          message: 'All repositories must belong to an organization to view custom property values.',
        }],
      }),
      new Error('exit 1'),
      'gh: All repositories must belong to an organization to view custom property values.'
    );

    // When
    const err = await ghGraphql('query { x }').catch((e: unknown) => e);

    // Then: the type survives, so a caller can tell this apart from a failure.
    expect(err).toBeInstanceOf(GitHubError);
    expect((err as GitHubError).type).toBe('NOT_ORG_OWNED_REPO');
  });

  it('reports the first error that actually carries a message', async () => {
    mockGh(JSON.stringify({ errors: [{ type: 'A', message: '' }, { type: 'B', message: 'real' }] }), null);

    const err = await ghGraphql('query { x }').catch((e: unknown) => e);

    expect((err as GitHubError).message).toBe('real');
    expect((err as GitHubError).type).toBe('B');
  });

  it('still fails on an exit status when the body has no errors[]', async () => {
    // A 401 answers with a bare `message` body, not a GraphQL envelope.
    mockGh(
      JSON.stringify({ message: 'Bad credentials' }),
      new Error('exit 1'),
      'gh: Bad credentials (HTTP 401)'
    );

    const err = await ghGraphql('query { x }').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GitHubAuthError);
  });

  it('carries no type for an error that came from stderr', () => {
    expect(mapExecError({ stderr: 'gh: something broke', code: undefined }))
      .toMatchObject({ type: null });
  });

  it('returns data when gh succeeds', async () => {
    mockGh(JSON.stringify({ data: { viewer: { login: 'octocat' } } }), null);

    await expect(ghGraphql('query { x }')).resolves.toEqual({ viewer: { login: 'octocat' } });
  });
});
