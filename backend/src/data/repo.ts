// DynamoDB single-table data-access layer (backend-only; MAY use @aws-sdk/*).
// Authority: docs/SPEC.md §9 (data model + access patterns), §9.2 (TTL), decisions
// D13/D16/D21/D22. Keys per §9:
//   PK = SESSION#<code>, SK = META | PLAYER#<id> | MOB#<id> | LOG
//
// DB item interfaces carry DB-only fields (token/secret hashes, ttl, keys); the
// mappers below STRIP those and return the pure domain shapes from ../domain/types,
// so nothing leaks a secret hash or the raw ttl to a snapshot.

import {
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { DEFAULTS } from '../domain/constants';
import type {
  AppliedCondition,
  LogEntry,
  Mob,
  MobTier,
  Player,
  PlayerPresence,
  PlayerStatus,
  SessionMeta,
  SessionSettings,
  SessionState,
} from '../domain/types';

/** Session TTL (§9.2 / D14): 3 days in epoch seconds. Every write refreshes it. */
export const SESSION_TTL_SECONDS = 3 * 24 * 60 * 60;

// ---------------------------------------------------------------------------
// DB item shapes (single table). PK/SK/ttl and the *Hash fields are DB-only.
// ---------------------------------------------------------------------------

interface Keyed {
  PK: string;
  SK: string;
}

export interface SessionItem extends Keyed {
  code: string;
  state: SessionState;
  glory: number;
  ruin: number;
  showRuin: boolean;
  round: number;
  settings: SessionSettings;
  gmTokenHash: string;
  nextPlayerIndex: number;
  createdAt: number;
  ttl: number;
}

export interface PlayerItem extends Keyed {
  id: string;
  index: number;
  name: string;
  maxWounds: number;
  wounds: number;
  maxShock: number;
  shock: number;
  wrath: number;
  conditions: AppliedCondition[];
  status: PlayerStatus;
  actedThisRound: boolean;
  presence: PlayerPresence;
  /** sha256 of the player token; optional — tokens are stateless (§12), stored for future revocation. */
  playerTokenHash?: string;
  /** sha256 of the one-time join secret handed back at join; checked by the claim handler. */
  joinSecretHash: string;
  joinedAt: number;
  ttl: number;
}

export interface MobItem extends Keyed {
  id: string;
  label: string;
  tier: MobTier;
  maxHp: number;
  hp: number;
  revealed: boolean;
  actedThisRound: boolean;
  conditions: AppliedCondition[];
  ttl: number;
}

export interface LogItem extends Keyed {
  /** compact log tuples (§5.4). */
  e: LogEntry[];
  ttl: number;
}

// ---------------------------------------------------------------------------
// Key helpers.
// ---------------------------------------------------------------------------

const pk = (code: string): string => `SESSION#${code}`;
const metaKey = (code: string) => ({ PK: pk(code), SK: 'META' });
const playerKey = (code: string, id: string) => ({ PK: pk(code), SK: `PLAYER#${id}` });
const logKey = (code: string) => ({ PK: pk(code), SK: 'LOG' });

// ---------------------------------------------------------------------------
// Mappers — DB item → pure domain shape. These are the ONLY exit from the data
// layer; each explicitly picks domain fields, dropping PK/SK/ttl/*Hash.
// ---------------------------------------------------------------------------

export function toSessionMeta(it: SessionItem): SessionMeta {
  return {
    code: it.code,
    state: it.state,
    glory: it.glory,
    ruin: it.ruin,
    showRuin: it.showRuin,
    round: it.round,
    settings: it.settings ?? {},
    createdAt: it.createdAt,
  };
}

export function toPlayer(it: PlayerItem): Player {
  return {
    id: it.id,
    index: it.index,
    name: it.name,
    maxWounds: it.maxWounds,
    wounds: it.wounds,
    maxShock: it.maxShock,
    shock: it.shock,
    wrath: it.wrath,
    conditions: it.conditions ?? [],
    status: it.status,
    presence: it.presence,
    actedThisRound: it.actedThisRound,
    joinedAt: it.joinedAt,
  };
}

export function toMob(it: MobItem): Mob {
  return {
    id: it.id,
    label: it.label,
    tier: it.tier,
    maxHp: it.maxHp,
    hp: it.hp,
    revealed: it.revealed,
    actedThisRound: it.actedThisRound,
    conditions: it.conditions ?? [],
  };
}

function isConditionalCheckFailed(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: string }).name === 'ConditionalCheckFailedException';
}

/** Hydrated board split (maps 1:1 onto a GmSnapshot: {session, players, mobs, log}). */
export interface Hydrated {
  meta: SessionMeta;
  players: Player[];
  mobs: Mob[];
  log: LogEntry[];
}

// ---------------------------------------------------------------------------
// Repo — thin wrapper over a DynamoDBDocumentClient for one table.
// ---------------------------------------------------------------------------

export class Repo {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    /** Injectable clock (epoch seconds) — real time by default; tests pin it. */
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  /** Table name from the environment, read lazily so tests can set it after import. */
  private get table(): string {
    const t = process.env.TABLE_NAME;
    if (!t) throw new Error('TABLE_NAME is not configured');
    return t;
  }

  /** Absolute TTL (epoch seconds) for a write: now + ttlSec (default 3 days). */
  private ttlAt(ttlSec: number = SESSION_TTL_SECONDS): number {
    return this.now() + ttlSec;
  }

  // --- Session meta -------------------------------------------------------

  /** Create the META item for a new session (state active, nextPlayerIndex 0). */
  async putSession(meta: SessionMeta, gmTokenHash: string, ttlSec: number = SESSION_TTL_SECONDS): Promise<void> {
    const item: SessionItem = {
      ...metaKey(meta.code),
      code: meta.code,
      state: meta.state,
      glory: meta.glory,
      ruin: meta.ruin,
      showRuin: meta.showRuin,
      round: meta.round,
      settings: meta.settings,
      gmTokenHash,
      nextPlayerIndex: 0,
      createdAt: meta.createdAt,
      ttl: this.ttlAt(ttlSec),
    };
    await this.doc.send(new PutCommand({ TableName: this.table, Item: item }));
  }

  async getMeta(code: string): Promise<SessionMeta | null> {
    const out = await this.doc.send(new GetCommand({ TableName: this.table, Key: metaKey(code) }));
    return out.Item ? toSessionMeta(out.Item as SessionItem) : null;
  }

  /** One Query hydrates the whole board (§9.1); split by SK prefix. Null if META gone. */
  async hydrate(code: string): Promise<Hydrated | null> {
    const out = await this.doc.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': pk(code) },
      }),
    );
    const items = (out.Items ?? []) as Array<Record<string, unknown>>;
    let metaItem: SessionItem | undefined;
    const players: Player[] = [];
    const mobs: Mob[] = [];
    let log: LogEntry[] = [];
    for (const it of items) {
      const sk = String(it.SK);
      if (sk === 'META') metaItem = it as unknown as SessionItem;
      else if (sk.startsWith('PLAYER#')) players.push(toPlayer(it as unknown as PlayerItem));
      else if (sk.startsWith('MOB#')) mobs.push(toMob(it as unknown as MobItem));
      else if (sk === 'LOG') log = (it as unknown as LogItem).e ?? [];
    }
    if (!metaItem) return null;
    // Stable ordering: players by join time then id; mobs by id.
    players.sort((a, b) => a.joinedAt - b.joinedAt || a.id.localeCompare(b.id));
    mobs.sort((a, b) => a.id.localeCompare(b.id));
    return { meta: toSessionMeta(metaItem), players, mobs, log };
  }

  // --- Players ------------------------------------------------------------

  /** Create a pending player (no index yet) with setup defaults + the join-secret hash. */
  async createPlayer(
    code: string,
    args: { id: string; name: string; joinSecretHash: string; ttlSec?: number },
  ): Promise<Player> {
    const item: PlayerItem = {
      ...playerKey(code, args.id),
      id: args.id,
      index: 0,
      name: args.name,
      maxWounds: DEFAULTS.player.maxWounds,
      wounds: DEFAULTS.player.maxWounds,
      maxShock: DEFAULTS.player.maxShock,
      shock: DEFAULTS.player.maxShock,
      wrath: DEFAULTS.player.wrath,
      conditions: [],
      status: 'active',
      actedThisRound: false,
      presence: 'pending',
      joinSecretHash: args.joinSecretHash,
      joinedAt: this.now(),
      ttl: this.ttlAt(args.ttlSec ?? SESSION_TTL_SECONDS),
    };
    await this.doc.send(
      new PutCommand({
        TableName: this.table,
        Item: item,
        ConditionExpression: 'attribute_not_exists(SK)',
      }),
    );
    return toPlayer(item);
  }

  /**
   * Admit (D21): atomically bump META.nextPlayerIndex (returns the new value),
   * then assign that index to the player and flip presence to 'admitted'.
   * Returns the assigned 1-based index.
   */
  async allocateIndexAndAdmit(code: string, playerId: string): Promise<number> {
    const ttl = this.ttlAt();
    const bump = await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: metaKey(code),
        UpdateExpression: 'SET #ttl = :ttl ADD nextPlayerIndex :one',
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':one': 1, ':ttl': ttl },
        ReturnValues: 'UPDATED_NEW',
      }),
    );
    const index = Number(bump.Attributes?.nextPlayerIndex ?? 0);
    await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: playerKey(code, playerId),
        UpdateExpression: 'SET #index = :idx, #presence = :admitted, #ttl = :ttl',
        ExpressionAttributeNames: { '#index': 'index', '#presence': 'presence', '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':idx': index, ':admitted': 'admitted', ':ttl': ttl },
      }),
    );
    return index;
  }

  /** Soft presence transition (admit/ignore/kick tombstones, D21). */
  async setPresence(code: string, playerId: string, presence: PlayerPresence): Promise<void> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: playerKey(code, playerId),
        UpdateExpression: 'SET #presence = :p, #ttl = :ttl',
        ExpressionAttributeNames: { '#presence': 'presence', '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':p': presence, ':ttl': this.ttlAt() },
      }),
    );
  }

  /** Raw item (incl. joinSecretHash / playerTokenHash) — for the claim handler's secret check. */
  async getPlayerRaw(code: string, playerId: string): Promise<PlayerItem | null> {
    const out = await this.doc.send(new GetCommand({ TableName: this.table, Key: playerKey(code, playerId) }));
    return (out.Item as PlayerItem | undefined) ?? null;
  }

  async getPlayer(code: string, playerId: string): Promise<Player | null> {
    const item = await this.getPlayerRaw(code, playerId);
    return item ? toPlayer(item) : null;
  }

  // --- Counters (reused in Phase 1) --------------------------------------

  /** Glory +/- with a floor-0 conditional decrement (D16). Returns the resulting value. */
  async addGlory(code: string, delta: number): Promise<number> {
    return this.addCounter(code, 'glory', delta);
  }

  /** Ruin +/- with a floor-0 conditional decrement (D16). Returns the resulting value. */
  async addRuin(code: string, delta: number): Promise<number> {
    return this.addCounter(code, 'ruin', delta);
  }

  /**
   * Atomic ADD on a floored counter (§9.1). Increments are unconditional; decrements
   * carry `#c >= :abs` so the pool never goes negative (D16). If a decrement would
   * underflow, the floor holds and the current value is returned unchanged.
   */
  private async addCounter(code: string, attr: 'glory' | 'ruin', delta: number): Promise<number> {
    const ttl = this.ttlAt();
    const names = { '#c': attr, '#ttl': 'ttl' };
    if (delta >= 0) {
      const out = await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: metaKey(code),
          UpdateExpression: 'SET #ttl = :ttl ADD #c :d',
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: { ':d': delta, ':ttl': ttl },
          ReturnValues: 'UPDATED_NEW',
        }),
      );
      return Number(out.Attributes?.[attr] ?? 0);
    }
    try {
      const out = await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: metaKey(code),
          UpdateExpression: 'SET #ttl = :ttl ADD #c :d',
          ConditionExpression: '#c >= :abs',
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: { ':d': delta, ':abs': -delta, ':ttl': ttl },
          ReturnValues: 'UPDATED_NEW',
        }),
      );
      return Number(out.Attributes?.[attr] ?? 0);
    } catch (err) {
      if (isConditionalCheckFailed(err)) {
        const meta = await this.getMeta(code);
        return meta ? meta[attr] : 0;
      }
      throw err;
    }
  }

  /** Append one compact log tuple atomically (§9.1 list_append; creates LOG lazily). */
  async appendLogEntry(code: string, entry: LogEntry): Promise<void> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: logKey(code),
        UpdateExpression: 'SET e = list_append(if_not_exists(e, :empty), :entry), #ttl = :ttl',
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':empty': [], ':entry': [entry], ':ttl': this.ttlAt() },
      }),
    );
  }
}
