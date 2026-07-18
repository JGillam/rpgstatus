// Shared domain types for the Wrath & Glory Session Assistant.
// Pure TypeScript — no runtime imports. Safe to import from both the Lambda backend
// and the Vite/React frontend. Authority: docs/SPEC.md §5, §9, decisions D1–D24.

export type Role = 'gm' | 'player';

/**
 * Persisted session lifecycle (D22). `expired` is never stored — it is derived
 * client-side when the session item is gone (TTL). See ClientSessionState.
 */
export type SessionState = 'active' | 'ended';
export type ClientSessionState = SessionState | 'expired';

/** Combat / defeated axis (§5). */
export type PlayerStatus = 'active' | 'down' | 'dying' | 'dead' | 'stable';

/** Lobby / membership axis (D21). Independent of PlayerStatus. */
export type PlayerPresence = 'pending' | 'admitted' | 'ignored' | 'removed';

export type MobTier = 'Troops' | 'Elite' | 'Adversary';

/** Player-facing coarse mob health (server projection; thresholds 75/40/1/0%). */
export type CoarseHp = 'healthy' | 'minor' | 'gravely' | 'dead';

/** Activity-log entry type code (D10). Extensible. */
export type LogType = 'G' | 'R';

/** Condition chip theming (D19). */
export type ConditionCategory = 'damage' | 'affliction' | 'impairment';

/**
 * A condition applied to a player or mob. `id` references ConditionDef.id; `rank`
 * is present for stackable conditions. Free-text/custom + `note` deferred to v2 (D17).
 */
export interface AppliedCondition {
  id: string;
  rank?: number;
}

/** A condition definition as shipped in /data/conditions.json. */
export interface ConditionDef {
  id: string;
  name: string;
  stacks: boolean;
  category: ConditionCategory;
  summary: string;
}

/** The full shape of /data/conditions.json. */
export interface ConditionsFile {
  edition: string;
  note: string;
  reference: string;
  categoryNote?: string;
  general: string[];
  conditions: ConditionDef[];
}

export interface SessionSettings {
  chapterName?: string;
}

/**
 * Player as seen by the GM and by clients. The secret playerTokenHash and the
 * DynamoDB `ttl` are DB-only and deliberately excluded from this shared type.
 */
export interface Player {
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
  presence: PlayerPresence;
  actedThisRound: boolean;
  joinedAt: number;
}

/** Full mob (GM view). */
export interface Mob {
  id: string;
  label: string;
  tier: MobTier;
  maxHp: number;
  hp: number;
  revealed: boolean;
  actedThisRound: boolean;
  conditions: AppliedCondition[];
}

/**
 * Player-facing mob projection: no exact hp/maxHp/actedThisRound, and only revealed
 * mobs are ever included in a PlayerSnapshot.
 */
export interface MobPublicView {
  id: string;
  label: string;
  tier: MobTier;
  coarse: CoarseHp;
  conditions: AppliedCondition[];
}

/**
 * Compact activity-log entry (D10). actorIndex 0 = GM, 1..n = player index.
 * ts = server-stamped epoch seconds.
 */
export type LogEntry = [actorIndex: number, delta: number, type: LogType, ts: number];

/** Decoded convenience shape for rendering a LogEntry. */
export interface LogEntryView {
  actorIndex: number;
  delta: number;
  type: LogType;
  ts: number;
}

/** Session meta (GM/client view). gmTokenHash and nextPlayerIndex are DB-only. */
export interface SessionMeta {
  code: string;
  state: SessionState;
  glory: number;
  ruin: number;
  showRuin: boolean;
  round: number;
  settings: SessionSettings;
  createdAt: number;
  /**
   * Epoch seconds when the session TTLs out (§9.2) — the META item's ttl, surfaced
   * for the GM header's "Expires in Nd Nh" (§7.6). Sliding: every write refreshes
   * the 3-day window, so this moves forward with table activity.
   */
  expiresAt: number;
}

/** Player projection of session meta: ruin === null when hidden by showRuin. */
export type PublicSessionMeta = Omit<SessionMeta, 'ruin'> & { ruin: number | null };

/** One Query hydrates the whole board (§9.1). GM view. */
export interface GmSnapshot {
  session: SessionMeta;
  players: Player[];
  mobs: Mob[];
  log: LogEntry[];
}

/** Player view of the board: coarse mobs, ruin possibly hidden, plus which player is "you". */
export interface PlayerSnapshot {
  session: PublicSessionMeta;
  players: Player[];
  mobs: MobPublicView[];
  log: LogEntry[];
  youId: string;
}
