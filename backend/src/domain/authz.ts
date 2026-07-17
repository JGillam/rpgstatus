// Pure authorization logic (§4 Roles & Permissions, §12, D13).
// PURITY RULE: no `node:*`, no `@aws-sdk/*`, no third-party runtime imports — the
// frontend imports this to gate optimistic UI. The HMAC token crypto lives in
// backend/src/auth/tokens.ts (which may use node:crypto) and depends on THIS module,
// never the reverse.

import type { Role } from './types';

/**
 * Claims carried in a signed token (§12). `playerIndex` is present for player tokens
 * (assigned at admit) and absent for GM tokens. `exp` is epoch seconds.
 */
export interface TokenClaims {
  code: string;
  role: Role;
  playerIndex?: number;
  exp: number;
}

/** What a mutation is trying to change. `player` names the target character's index. */
export type MutationTarget =
  | { kind: 'glory' }
  | { kind: 'ruin' }
  | { kind: 'round' }
  | { kind: 'session' }
  | { kind: 'mob' }
  | { kind: 'player'; playerIndex: number };

/**
 * Decide whether `claims` may perform the mutation on `target` (§4 permission matrix).
 * - GM: everything.
 * - Player: Glory push/pull (shared), and edits to ONLY their own character.
 *   Ruin, round advance, session, and mob management are GM-only → false for players.
 */
export function authorize(claims: TokenClaims, target: MutationTarget): boolean {
  if (claims.role === 'gm') return true;

  // Player scope.
  switch (target.kind) {
    case 'glory':
      return true;
    case 'player':
      return target.playerIndex === claims.playerIndex;
    case 'ruin':
    case 'round':
    case 'session':
    case 'mob':
      return false;
    default:
      // Exhaustiveness guard: any future target kind is denied to players by default.
      return false;
  }
}
