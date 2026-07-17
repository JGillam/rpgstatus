import { describe, it, expect } from 'vitest';
import { authorize } from './authz';
import type { MutationTarget, TokenClaims } from './authz';

const player: TokenClaims = { code: 'ABCDE', role: 'player', playerIndex: 2, exp: 9999 };
const gm: TokenClaims = { code: 'ABCDE', role: 'gm', exp: 9999 };

describe('authorize — player scope (§4)', () => {
  it('can push/pull Glory', () => {
    expect(authorize(player, { kind: 'glory' })).toBe(true);
  });

  it('can edit their OWN character only', () => {
    expect(authorize(player, { kind: 'player', playerIndex: 2 })).toBe(true);
    expect(authorize(player, { kind: 'player', playerIndex: 3 })).toBe(false);
  });

  it('cannot touch Ruin / round / mob / session', () => {
    const denied: MutationTarget[] = [
      { kind: 'ruin' },
      { kind: 'round' },
      { kind: 'mob' },
      { kind: 'session' },
    ];
    for (const t of denied) expect(authorize(player, t)).toBe(false);
  });

  it('with no playerIndex cannot edit any character', () => {
    const indexless: TokenClaims = { code: 'ABCDE', role: 'player', exp: 9999 };
    expect(authorize(indexless, { kind: 'player', playerIndex: 1 })).toBe(false);
  });
});

describe('authorize — GM scope (§4)', () => {
  it('can do everything', () => {
    const all: MutationTarget[] = [
      { kind: 'glory' },
      { kind: 'ruin' },
      { kind: 'round' },
      { kind: 'session' },
      { kind: 'mob' },
      { kind: 'player', playerIndex: 5 },
    ];
    for (const t of all) expect(authorize(gm, t)).toBe(true);
  });
});
