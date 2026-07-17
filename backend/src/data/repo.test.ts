import { beforeEach, describe, expect, it } from 'vitest';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { LogEntry, SessionMeta } from '../domain/types';
import { installDdbStore } from '../test-support/ddbStore';
import { Repo, SESSION_TTL_SECONDS, type MobItem, type PlayerItem } from './repo';

const store = installDdbStore();
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const NOW = 1_700_000_000;
const THREE_DAYS = SESSION_TTL_SECONDS;
const repo = new Repo(doc, () => NOW);

function baseMeta(code: string): SessionMeta {
  return {
    code,
    state: 'active',
    glory: 0,
    ruin: 0,
    showRuin: false,
    round: 1,
    settings: { chapterName: 'Chapter One' },
    createdAt: NOW,
  };
}

beforeEach(() => store.reset());

describe('putSession / getMeta', () => {
  it('persists META with keys, ttl=now+3d, nextPlayerIndex 0, and the gm hash', async () => {
    await repo.putSession(baseMeta('ABCDE'), 'gmhash', THREE_DAYS);
    const item = store.get('SESSION#ABCDE', 'META');
    expect(item).toBeDefined();
    expect(item).toMatchObject({
      PK: 'SESSION#ABCDE',
      SK: 'META',
      state: 'active',
      round: 1,
      nextPlayerIndex: 0,
      gmTokenHash: 'gmhash',
      ttl: NOW + THREE_DAYS,
    });
  });

  it('getMeta maps to SessionMeta and strips DB-only fields', async () => {
    await repo.putSession(baseMeta('ABCDE'), 'gmhash', THREE_DAYS);
    const meta = await repo.getMeta('ABCDE');
    expect(meta).toEqual(baseMeta('ABCDE'));
    // No DB-only fields leak into the domain shape.
    expect(meta as object).not.toHaveProperty('gmTokenHash');
    expect(meta as object).not.toHaveProperty('nextPlayerIndex');
    expect(meta as object).not.toHaveProperty('ttl');
    expect(meta as object).not.toHaveProperty('PK');
  });

  it('getMeta returns null when absent', async () => {
    expect(await repo.getMeta('NOPE1')).toBeNull();
  });
});

describe('createPlayer / getPlayer', () => {
  it('creates a pending player with setup defaults and the join-secret hash', async () => {
    await repo.putSession(baseMeta('ABCDE'), 'gmhash', THREE_DAYS);
    const player = await repo.createPlayer('ABCDE', { id: 'p1', name: 'Bob', joinSecretHash: 'sechash' });

    expect(player).toMatchObject({
      id: 'p1',
      name: 'Bob',
      index: 0,
      presence: 'pending',
      status: 'active',
      actedThisRound: false,
      maxWounds: 12,
      wounds: 12,
      maxShock: 6,
      shock: 6,
      wrath: 0,
      joinedAt: NOW,
    });
    // Mapped Player never carries the secret hash.
    expect(player as object).not.toHaveProperty('joinSecretHash');

    const raw = store.get('SESSION#ABCDE', 'PLAYER#p1') as PlayerItem;
    expect(raw.joinSecretHash).toBe('sechash');
    expect(raw.ttl).toBe(NOW + THREE_DAYS);
  });

  it('getPlayer strips the secret hash; getPlayerRaw exposes it', async () => {
    await repo.putSession(baseMeta('ABCDE'), 'gmhash', THREE_DAYS);
    await repo.createPlayer('ABCDE', { id: 'p1', name: 'Bob', joinSecretHash: 'sechash' });

    const mapped = await repo.getPlayer('ABCDE', 'p1');
    expect(mapped as object).not.toHaveProperty('joinSecretHash');

    const raw = await repo.getPlayerRaw('ABCDE', 'p1');
    expect(raw?.joinSecretHash).toBe('sechash');
  });

  it('getPlayer returns null when absent', async () => {
    expect(await repo.getPlayer('ABCDE', 'ghost')).toBeNull();
  });
});

describe('allocateIndexAndAdmit', () => {
  it('assigns sequential 1-based indices and flips presence to admitted', async () => {
    await repo.putSession(baseMeta('ABCDE'), 'gmhash', THREE_DAYS);
    await repo.createPlayer('ABCDE', { id: 'p1', name: 'Bob', joinSecretHash: 'h1' });
    await repo.createPlayer('ABCDE', { id: 'p2', name: 'Amy', joinSecretHash: 'h2' });

    const i1 = await repo.allocateIndexAndAdmit('ABCDE', 'p1');
    const i2 = await repo.allocateIndexAndAdmit('ABCDE', 'p2');
    expect(i1).toBe(1);
    expect(i2).toBe(2);

    const p1 = await repo.getPlayer('ABCDE', 'p1');
    expect(p1).toMatchObject({ index: 1, presence: 'admitted' });
    expect(store.get('SESSION#ABCDE', 'META')!.nextPlayerIndex).toBe(2);
  });
});

describe('setPresence', () => {
  it('updates presence and refreshes ttl', async () => {
    await repo.putSession(baseMeta('ABCDE'), 'gmhash', THREE_DAYS);
    await repo.createPlayer('ABCDE', { id: 'p1', name: 'Bob', joinSecretHash: 'h1' });
    await repo.setPresence('ABCDE', 'p1', 'removed');
    const raw = store.get('SESSION#ABCDE', 'PLAYER#p1') as PlayerItem;
    expect(raw.presence).toBe('removed');
    expect(raw.ttl).toBe(NOW + THREE_DAYS);
  });
});

describe('addGlory / addRuin (floor-0, D16)', () => {
  it('increments unconditionally and floors decrements at 0', async () => {
    await repo.putSession(baseMeta('ABCDE'), 'gmhash', THREE_DAYS);
    expect(await repo.addGlory('ABCDE', 2)).toBe(2);
    expect(await repo.addGlory('ABCDE', 1)).toBe(3);
    expect(await repo.addGlory('ABCDE', -1)).toBe(2);
    // Would underflow (2 - 5): conditional fails → floor holds, value unchanged.
    expect(await repo.addGlory('ABCDE', -5)).toBe(2);

    expect(await repo.addRuin('ABCDE', 4)).toBe(4);
    expect(await repo.addRuin('ABCDE', -4)).toBe(0);
    expect(await repo.addRuin('ABCDE', -1)).toBe(0);
  });
});

describe('appendLogEntry / hydrate', () => {
  it('appends compact tuples and hydrate splits the partition by SK', async () => {
    await repo.putSession(baseMeta('ABCDE'), 'gmhash', THREE_DAYS);
    await repo.createPlayer('ABCDE', { id: 'p1', name: 'Bob', joinSecretHash: 'h1' });
    store.seed({
      PK: 'SESSION#ABCDE',
      SK: 'MOB#m1',
      id: 'm1',
      label: 'Grot',
      tier: 'Troops',
      maxHp: 6,
      hp: 6,
      revealed: true,
      actedThisRound: false,
      conditions: [],
      ttl: NOW + THREE_DAYS,
    } satisfies MobItem);

    const e1: LogEntry = [0, 1, 'G', NOW];
    const e2: LogEntry = [1, -1, 'G', NOW + 5];
    await repo.appendLogEntry('ABCDE', e1);
    await repo.appendLogEntry('ABCDE', e2);

    const hydrated = await repo.hydrate('ABCDE');
    expect(hydrated).not.toBeNull();
    expect(hydrated!.meta.code).toBe('ABCDE');
    expect(hydrated!.players).toHaveLength(1);
    expect(hydrated!.mobs).toHaveLength(1);
    expect(hydrated!.log).toEqual([e1, e2]);
  });

  it('hydrate returns null when META is gone', async () => {
    store.seed({
      PK: 'SESSION#GHOST',
      SK: 'PLAYER#p1',
      id: 'p1',
      index: 0,
      name: 'x',
      maxWounds: 12,
      wounds: 12,
      maxShock: 6,
      shock: 6,
      wrath: 0,
      conditions: [],
      status: 'active',
      actedThisRound: false,
      presence: 'pending',
      joinSecretHash: 'h',
      joinedAt: NOW,
      ttl: NOW + THREE_DAYS,
    } satisfies PlayerItem);
    expect(await repo.hydrate('GHOST')).toBeNull();
  });
});
