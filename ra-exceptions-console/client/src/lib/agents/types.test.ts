import { describe, it, expect } from 'vitest';
import { isBlocked, type PipelineState } from './types';

describe('isBlocked', () => {
  it('blocks on unavailable', () => {
    expect(isBlocked('unavailable')).toBe(true);
  });

  it('blocks on red', () => {
    expect(isBlocked('red')).toBe(true);
  });

  it('blocks on stale — stale evidence must fail closed, not render with a soft warning', () => {
    expect(isBlocked('stale')).toBe(true);
  });

  it('does not block on ok', () => {
    expect(isBlocked('ok')).toBe(false);
  });

  it('every PipelineState is exhaustively covered by exactly one branch', () => {
    const states: PipelineState[] = ['unavailable', 'red', 'stale', 'ok'];
    const blocked = states.filter(isBlocked);
    const unblocked = states.filter((s) => !isBlocked(s));
    expect(blocked.sort()).toEqual(['red', 'stale', 'unavailable']);
    expect(unblocked).toEqual(['ok']);
  });
});
