// Pure domain logic for the Wrath & Glory Session Assistant.
// PURITY RULE: no `node:*`, no `@aws-sdk/*`, no third-party runtime imports — this
// module is imported by the frontend too. Only ./types (type-only) and ./constants.
// Authority: docs/SPEC.md §5, §5.4, §8, §9.1; decisions D15/D16.

import type {
  CoarseHp,
  GmSnapshot,
  LogEntry,
  LogEntryView,
  LogType,
  Mob,
  MobPublicView,
  Player,
  PlayerSnapshot,
  PublicSessionMeta,
} from './types';
import { COARSE_THRESHOLDS, LIMITS } from './constants';

/** Real minus sign (U+2212), used in human log strings instead of an ASCII hyphen. */
const MINUS = '−';

/** Clamp `value` into the inclusive range [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Project exact mob HP to the player-facing coarse label (§5, Q-C thresholds 75/40/1/0%).
 * hp <= 0 → 'dead'; maxHp <= 0 with hp > 0 is treated as full (guard against /0).
 */
export function coarse(hp: number, maxHp: number): CoarseHp {
  if (hp <= 0) return 'dead';
  const fraction = maxHp > 0 ? hp / maxHp : 1;
  if (fraction >= COARSE_THRESHOLDS.healthy) return 'healthy';
  if (fraction >= COARSE_THRESHOLDS.minor) return 'minor';
  return 'gravely';
}

/** Apply a signed delta to a floored counter (Glory/Ruin, D16 floor at 0). */
export function nextCounter(current: number, delta: number, min: number = LIMITS.counter.min): number {
  return Math.max(min, current + delta);
}

/** Clamp a current track (Wounds/Shock) into 0..max. */
export function clampCurrent(value: number, max: number): number {
  return clamp(value, 0, max);
}

/** Clamp Wrath into its configured bounds (0..6, D16). */
export function clampWrath(value: number): number {
  return clamp(value, LIMITS.wrath.min, LIMITS.wrath.max);
}

/**
 * "Next round" (D15): bump the round and clear the acted flag on every player AND mob.
 * IMMUTABLE — returns new arrays/objects; the inputs are never mutated.
 */
export function advanceRound(
  round: number,
  players: Player[],
  mobs: Mob[],
): { round: number; players: Player[]; mobs: Mob[] } {
  return {
    round: round + 1,
    players: players.map((p) => ({ ...p, actedThisRound: false })),
    mobs: mobs.map((m) => ({ ...m, actedThisRound: false })),
  };
}

/** Build a compact log tuple (§5.4). */
export function encodeLog(actorIndex: number, delta: number, type: LogType, ts: number): LogEntry {
  return [actorIndex, delta, type, ts];
}

/** Decode a compact log tuple into a named view for rendering. */
export function decodeLog(e: LogEntry): LogEntryView {
  return { actorIndex: e[0], delta: e[1], type: e[2], ts: e[3] };
}

/**
 * Append an entry and keep only the newest `cap` entries (§5.4 soft-cap ~1000; trim oldest).
 * IMMUTABLE — returns a new array.
 */
export function appendLog(log: LogEntry[], entry: LogEntry, cap = 1000): LogEntry[] {
  const next = [...log, entry];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/** Format a signed delta with a real minus for negatives: 1 → "+1", -1 → "−1". */
function signed(delta: number): string {
  return delta < 0 ? `${MINUS}${Math.abs(delta)}` : `+${delta}`;
}

/**
 * Render a decoded log entry to a human string (§5.4). actorIndex 0 → "GM"; other
 * indices resolved via `nameByIndex`. Wording matches the design prototypes:
 *   Glory: "Bob pushed +1 to Glory" / "Bob pulled −1 from Glory"
 *   Ruin:  "GM raised Ruin (+1)"    / "GM lowered Ruin (−1)"
 */
export function formatLog(view: LogEntryView, nameByIndex: (i: number) => string): string {
  const name = view.actorIndex === 0 ? 'GM' : nameByIndex(view.actorIndex);
  const amount = signed(view.delta);
  if (view.type === 'G') {
    return view.delta < 0
      ? `${name} pulled ${amount} from Glory`
      : `${name} pushed ${amount} to Glory`;
  }
  // 'R' (Ruin) and any future counter types default to raise/lower wording.
  return view.delta < 0 ? `${name} lowered Ruin (${amount})` : `${name} raised Ruin (${amount})`;
}

/**
 * SECURITY-CRITICAL (§8/§9.1): project a full mob to the player-facing view.
 * NEVER include hp, maxHp, or actedThisRound — only id/label/tier/coarse/conditions.
 */
export function projectMob(mob: Mob): MobPublicView {
  return {
    id: mob.id,
    label: mob.label,
    tier: mob.tier,
    coarse: coarse(mob.hp, mob.maxHp),
    conditions: mob.conditions,
  };
}

/**
 * SECURITY-CRITICAL (§8/§9.1): derive a player's snapshot from the GM snapshot.
 * - Unrevealed mobs are dropped entirely (default-hidden: only `revealed === true` survives).
 * - Surviving mobs are coarsened via projectMob (no exact HP / acted flag leaks).
 * - `players` pass through unchanged (the roster is shared, §7.5).
 * - Ruin is nulled unless `showRuin` is on (D1).
 */
export function projectForPlayer(snap: GmSnapshot, youId: string): PlayerSnapshot {
  const session: PublicSessionMeta = {
    ...snap.session,
    ruin: snap.session.showRuin ? snap.session.ruin : null,
  };
  return {
    session,
    players: snap.players,
    mobs: snap.mobs.filter((m) => m.revealed).map(projectMob),
    log: snap.log,
    youId,
  };
}
