import { describe, it, expect } from 'vitest';
import { OWNER_TEAM_PROPERTY, ownerTeamSlug, sortOwners, toOwners } from './githubOwners';

describe('ownerTeamSlug', () => {
  it('picks the responsible team out of the full property set', () => {
    // Given a repository carrying the properties a real org repo has
    const nodes = [
      { propertyName: 'production', value: 'true' },
      { propertyName: OWNER_TEAM_PROPERTY, value: 'gamma-team' },
      { propertyName: 'sca_required', value: 'false' },
    ];

    // When / Then
    expect(ownerTeamSlug(nodes)).toBe('gamma-team');
  });

  it('treats an absent, blank or unset property as no owning team', () => {
    // A personal repository answers with no nodes at all, and an org repo can
    // carry the property with nothing in it.
    expect(ownerTeamSlug(undefined)).toBeNull();
    expect(ownerTeamSlug(null)).toBeNull();
    expect(ownerTeamSlug([])).toBeNull();
    expect(ownerTeamSlug([{ propertyName: 'production', value: 'true' }])).toBeNull();
    expect(ownerTeamSlug([{ propertyName: OWNER_TEAM_PROPERTY, value: '  ' }])).toBeNull();
    expect(ownerTeamSlug([{ propertyName: OWNER_TEAM_PROPERTY, value: null }])).toBeNull();
  });

  it('trims the slug, which is sent on as a query variable', () => {
    expect(ownerTeamSlug([{ propertyName: OWNER_TEAM_PROPERTY, value: ' gamma-team ' }]))
      .toBe('gamma-team');
  });
});

describe('toOwners', () => {
  it('keeps login and display name, dropping empty names', () => {
    // Given a member with no display name set
    const nodes = [
      { login: 'JFH_NYK', name: 'Jens Fabricius Hansen' },
      { login: 'MKA_NYK', name: '' },
    ];

    // When / Then: an empty string is not a name, and would render as a blank
    // tooltip rather than falling back to the login.
    expect(toOwners(nodes)).toEqual([
      { login: 'JFH_NYK', name: 'Jens Fabricius Hansen' },
      { login: 'MKA_NYK', name: null },
    ]);
  });

  it('de-duplicates across pages and skips nodes without a login', () => {
    // Given the concatenation of two cursor pages that overlap
    const nodes = [
      { login: 'JFH_NYK', name: null },
      null,
      { login: null, name: 'ghost' },
      { login: 'JFH_NYK', name: null },
    ];

    // When / Then
    expect(toOwners(nodes)).toEqual([{ login: 'JFH_NYK', name: null }]);
  });
});

describe('sortOwners', () => {
  it('orders by login case-insensitively so the list does not reshuffle', () => {
    // Given GitHub's undocumented member order, which mixes casing
    const members = [
      { login: 'mokl_NYK', name: null },
      { login: 'JFH_NYK', name: null },
      { login: 'MKA_NYK', name: null },
    ];

    // When
    const sorted = sortOwners(members);

    // Then
    expect(sorted.map((m) => m.login)).toEqual(['JFH_NYK', 'MKA_NYK', 'mokl_NYK']);
  });

  it('does not mutate its input', () => {
    // Given
    const members = [{ login: 'b', name: null }, { login: 'a', name: null }];

    // When
    sortOwners(members);

    // Then
    expect(members.map((m) => m.login)).toEqual(['b', 'a']);
  });
});
