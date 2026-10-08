import { describe, it, expect } from 'vitest';
import { absoluteTime } from './absoluteTime';

describe('absoluteTime', () => {
  it('formats as DD-MM-YYYY HH:mm in local time', () => {
    // Given
    const local = new Date(2026, 8, 6, 4, 5);

    // When
    const text = absoluteTime(local.toISOString());

    // Then
    expect(text).toBe('06-09-2026 04:05');
  });

  it('returns an empty string for a missing or invalid value', () => {
    expect(absoluteTime(null)).toBe('');
    expect(absoluteTime(undefined)).toBe('');
    expect(absoluteTime('not a date')).toBe('');
  });
});
