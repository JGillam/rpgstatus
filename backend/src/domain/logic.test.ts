import { describe, it, expect } from 'vitest';
import {
  clamp,
  coarse,
  nextCounter,
  clampCurrent,
  clampWrath,
  advanceRound,
  encodeLog,
  decodeLog,
  appendLog,
  formatLog,
  projectMob,
  projectForPlayer,
} from './logic';
import type { GmSnapshot, LogEntry, Mob, Player, SessionMeta } from './types';

const MINUS = '−'; // real minus sign used in log strings

const mkPlayer = (over: Partial<Player> = {}): Player => ({
  id: 'p1',
  index: 1,
  name: 'Bob',
  maxWounds: 12,
  wounds: 12,
  maxShock: 6,
  shock: 6,
  wrath: 0,
  conditions: [],
  status: 'active',
  presence: 'admitted',
  actedThisRound: false,
  joinedAt: 0,
  ...over,
});

const mkMob = (over: Partial<Mob> = {}): Mob => ({
  id: 'm1',
  label: 'Grot',
  tier: 'Troops',
  maxHp: 10,
  hp: 10,
  revealed: true,
  actedThisRound: false,
  conditions: [],
  ...over,
});

const mkSession = (over: Partial<SessionMeta> = {}): SessionMeta => ({
  code: 'ABCDE',
  state: 'active',
  glory: 5,
  ruin: 3,
  showRuin: false,
  round: 2,
  settings: {},
  createdAt: 0,
  expiresAt: 3 * 24 * 3600,
  ...over,
});

describe('coarse', () => {
  it('maps HP fractions to labels at the 75/40/1/0 boundaries', () => {
    expect(coarse(0, 10)).toBe('dead'); // 0 -> dead
    expect(coarse(-5, 10)).toBe('dead'); // negative -> dead
    expect(coarse(10, 10)).toBe('healthy'); // full -> healthy
    expect(coarse(3, 4)).toBe('healthy'); // exactly 0.75 -> healthy
    expect(coarse(75, 100)).toBe('healthy'); // 0.75 -> healthy
    expect(coarse(74, 100)).toBe('minor'); // 0.74 -> minor
    expect(coarse(40, 100)).toBe('minor'); // exactly 0.40 -> minor
    expect(coarse(2, 5)).toBe('minor'); // 0.40 -> minor
    expect(coarse(39, 100)).toBe('gravely'); // 0.39 -> gravely
    expect(coarse(1, 100)).toBe('gravely');
  });

  it('guards against maxHp <= 0 (no division by zero)', () => {
    expect(coarse(5, 0)).toBe('healthy'); // hp>0, maxHp 0 -> treated as full
    expect(coarse(0, 0)).toBe('dead'); // hp<=0 short-circuits first
  });
});

describe('clamp / clampCurrent / clampWrath', () => {
  it('clamp keeps values within [min,max]', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });

  it('clampCurrent bounds a track to 0..max', () => {
    expect(clampCurrent(5, 12)).toBe(5);
    expect(clampCurrent(-2, 12)).toBe(0);
    expect(clampCurrent(99, 12)).toBe(12);
  });

  it('clampWrath caps at 6 and floors at 0 (D16)', () => {
    expect(clampWrath(3)).toBe(3);
    expect(clampWrath(7)).toBe(6);
    expect(clampWrath(-1)).toBe(0);
  });
});

describe('nextCounter', () => {
  it('adds the delta and floors at 0 by default (D16)', () => {
    expect(nextCounter(3, 2)).toBe(5);
    expect(nextCounter(0, -1)).toBe(0); // floor
    expect(nextCounter(1, -5)).toBe(0); // floor
    expect(nextCounter(5, -2)).toBe(3);
  });

  it('honours a custom floor', () => {
    expect(nextCounter(0, -2, -3)).toBe(-2);
    expect(nextCounter(0, -5, -3)).toBe(-3);
  });
});

describe('advanceRound', () => {
  it('bumps the round and clears acted on BOTH players and mobs (D15)', () => {
    const players = [mkPlayer({ actedThisRound: true }), mkPlayer({ id: 'p2', index: 2, actedThisRound: true })];
    const mobs = [mkMob({ actedThisRound: true }), mkMob({ id: 'm2', actedThisRound: true })];

    const out = advanceRound(3, players, mobs);

    expect(out.round).toBe(4);
    expect(out.players.every((p) => p.actedThisRound === false)).toBe(true);
    expect(out.mobs.every((m) => m.actedThisRound === false)).toBe(true);
  });

  it('does NOT mutate its inputs (immutable)', () => {
    const players = [mkPlayer({ actedThisRound: true })];
    const mobs = [mkMob({ actedThisRound: true })];

    const out = advanceRound(1, players, mobs);

    expect(players[0]!.actedThisRound).toBe(true); // original untouched
    expect(mobs[0]!.actedThisRound).toBe(true);
    expect(out.players).not.toBe(players); // new array
    expect(out.players[0]).not.toBe(players[0]); // new object
    expect(out.mobs).not.toBe(mobs);
    expect(out.mobs[0]).not.toBe(mobs[0]);
  });
});

describe('log encode/decode/append', () => {
  it('encode/decode round-trips', () => {
    const entry = encodeLog(1, 1, 'G', 1721145600);
    expect(entry).toEqual([1, 1, 'G', 1721145600]);
    expect(decodeLog(entry)).toEqual({ actorIndex: 1, delta: 1, type: 'G', ts: 1721145600 });
    expect(decodeLog(encodeLog(0, -1, 'R', 42))).toEqual({ actorIndex: 0, delta: -1, type: 'R', ts: 42 });
  });

  it('appendLog appends onto an empty log immutably', () => {
    const log: LogEntry[] = [];
    const entry = encodeLog(1, 1, 'G', 1);
    const out = appendLog(log, entry);
    expect(out).toEqual([entry]);
    expect(log).toHaveLength(0); // original untouched
  });

  it('appendLog trims oldest and keeps the newest `cap` entries (§5.4)', () => {
    const a = encodeLog(1, 1, 'G', 1);
    const b = encodeLog(1, 1, 'G', 2);
    const c = encodeLog(1, 1, 'G', 3);
    const d = encodeLog(1, 1, 'G', 4);
    const out = appendLog([a, b, c], d, 3);
    expect(out).toEqual([b, c, d]); // dropped the oldest (a)
    expect(out).toHaveLength(3);
  });
});

describe('formatLog', () => {
  const nameByIndex = (i: number) => (i === 1 ? 'Bob' : i === 0 ? 'SHOULD_NOT_APPEAR' : `P${i}`);

  it('formats Glory push/pull with a real minus for pulls', () => {
    expect(formatLog(decodeLog(encodeLog(1, 1, 'G', 0)), nameByIndex)).toBe('Bob pushed +1 to Glory');
    expect(formatLog(decodeLog(encodeLog(1, -1, 'G', 0)), nameByIndex)).toBe(`Bob pulled ${MINUS}1 from Glory`);
  });

  it('formats Ruin raise/lower', () => {
    expect(formatLog(decodeLog(encodeLog(0, 1, 'R', 0)), nameByIndex)).toBe('GM raised Ruin (+1)');
    expect(formatLog(decodeLog(encodeLog(0, -1, 'R', 0)), nameByIndex)).toBe(`GM lowered Ruin (${MINUS}1)`);
  });

  it('maps actorIndex 0 to "GM" regardless of nameByIndex', () => {
    expect(formatLog(decodeLog(encodeLog(0, 1, 'G', 0)), nameByIndex)).toBe('GM pushed +1 to Glory');
  });
});

describe('projectMob', () => {
  it('exposes only coarse HP and never hp/maxHp/actedThisRound', () => {
    const mob = mkMob({ hp: 4, maxHp: 10, actedThisRound: true });
    const view = projectMob(mob);
    expect(view).toEqual({ id: 'm1', label: 'Grot', tier: 'Troops', coarse: 'minor', conditions: [] });
    expect('hp' in view).toBe(false);
    expect('maxHp' in view).toBe(false);
    expect('actedThisRound' in view).toBe(false);
  });
});

describe('projectForPlayer', () => {
  it('drops unrevealed mobs and coarsens revealed ones with no hp/maxHp/acted leaks', () => {
    const snap: GmSnapshot = {
      session: mkSession({ showRuin: false }),
      players: [mkPlayer()],
      mobs: [
        mkMob({ id: 'seen', hp: 3, maxHp: 10, revealed: true, actedThisRound: true }),
        mkMob({ id: 'hidden', revealed: false }),
      ],
      log: [],
    };

    const out = projectForPlayer(snap, 'p1');

    expect(out.mobs).toHaveLength(1);
    const mob = out.mobs[0]!;
    expect(mob.id).toBe('seen');
    expect(mob.coarse).toBe('gravely'); // 3/10 = 0.30
    expect('hp' in mob).toBe(false);
    expect('maxHp' in mob).toBe(false);
    expect('actedThisRound' in mob).toBe(false);
    expect(out.youId).toBe('p1');
    expect(out.players).toBe(snap.players); // roster passes through unchanged
  });

  it('nulls ruin when showRuin is false and reveals it when true', () => {
    const base: GmSnapshot = { session: mkSession({ ruin: 7 }), players: [], mobs: [], log: [] };

    const hidden = projectForPlayer({ ...base, session: mkSession({ ruin: 7, showRuin: false }) }, 'x');
    expect(hidden.session.ruin).toBeNull();

    const shown = projectForPlayer({ ...base, session: mkSession({ ruin: 7, showRuin: true }) }, 'x');
    expect(shown.session.ruin).toBe(7);
  });
});
