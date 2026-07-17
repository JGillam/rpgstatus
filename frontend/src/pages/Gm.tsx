import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import type {
  AppliedCondition,
  CoarseHp,
  ConditionCategory,
  GmSnapshot,
  Mob,
  MobTier,
  Player,
  PlayerStatus,
  SessionMeta,
} from '@domain';
import {
  clampCurrent,
  clampWrath,
  coarse,
  decodeLog,
  DEFAULTS,
  formatLog,
  LIMITS,
  nextCounter,
} from '@domain';
import {
  addMobs,
  adjustGlory,
  adjustRuin,
  admit,
  deleteMob,
  duplicateMob,
  endSession,
  kick,
  nextRound,
  updateMob,
  updatePlayer,
  updateSession,
  type AddMobsInput,
} from '@/lib/api';
import { clearIdentity, loadIdentity } from '@/lib/identity';
import { useSessionState } from '@/lib/useSessionState';
import { coarseColor, coarseLabel, statusColor, statusLabel } from '@/lib/theme';
import { CONDITIONS, conditionDef } from '@/lib/conditions';
import { Dialog } from '@/components/Dialog';
import { cn } from '@/lib/utils';

const STATUSES: PlayerStatus[] = ['active', 'down', 'dying', 'dead', 'stable'];
const TIERS: MobTier[] = ['Troops', 'Elite', 'Adversary'];
const MOB_LABEL_MAX = 40;

// Condition-chip theming for the GM console — a LOCAL remap that matches the player
// screen (Play.tsx) so both agree: damage = red, affliction = violet, impairment = gold.
// (theme.ts keeps impairment blue elsewhere; the prototype's name-based palette is this.)
const CONDITION_CHIP_COLOR: Record<ConditionCategory, string> = {
  damage: 'var(--color-red)',
  affliction: 'var(--color-violet)',
  impairment: 'var(--color-gold)',
};
const chipColor = (c: ConditionCategory): string => CONDITION_CHIP_COLOR[c];

/** Alpha'd colour from a token/var — for subtle tints on var-based colours. */
const alpha = (color: string, pct: number): string =>
  `color-mix(in srgb, ${color} ${pct}%, transparent)`;

const tierColor = (t: MobTier): string =>
  t === 'Elite' ? 'var(--color-gold)' : t === 'Adversary' ? 'var(--color-violet)' : 'var(--color-muted)';

interface Freshness {
  secondsAgo: number;
  updatedAt: number | null;
  error: boolean;
}

/** Target of the shared condition picker — a player card or a mob row. */
type CondTarget = { kind: 'player'; id: string } | { kind: 'mob'; id: string };

// ---------------------------------------------------------------------------
// Route entry: identity guard + polling, then hand off to the console.
// ---------------------------------------------------------------------------

export default function Gm() {
  const navigate = useNavigate();
  const identity = useMemo(() => loadIdentity(), []);

  const args = identity?.role === 'gm' ? { code: identity.code, token: identity.token } : null;
  const { snapshot, secondsAgo, updatedAt, error, loading, refresh } =
    useSessionState<GmSnapshot>(args);

  if (!identity || identity.role !== 'gm') return <Navigate to="/" replace />;

  const onEnded = () => {
    clearIdentity();
    navigate('/', { replace: true });
  };

  if (!snapshot) {
    return (
      <div className="grid min-h-dvh place-items-center bg-bg px-6 text-center">
        <p className="text-muted">
          {loading ? 'Loading session…' : error ? 'Connection lost. Retrying…' : 'No session.'}
        </p>
      </div>
    );
  }

  return (
    <GmConsole
      snapshot={snapshot}
      code={identity.code}
      token={identity.token}
      freshness={{ secondsAgo, updatedAt, error: !!error }}
      refresh={refresh}
      onEnded={onEnded}
    />
  );
}

// ---------------------------------------------------------------------------
// Console — owns the optimistic overlays and every GM mutation.
// ---------------------------------------------------------------------------

interface ConsoleProps {
  snapshot: GmSnapshot;
  code: string;
  token: string;
  freshness: Freshness;
  refresh: () => void;
  onEnded: () => void;
}

function GmConsole({ snapshot, code, token, freshness, refresh, onEnded }: ConsoleProps) {
  // Optimistic overlays merged over server truth; `pending` counts in-flight PATCHes so we
  // only re-adopt the server snapshot once nothing is mid-flight (reconcile on the next poll).
  const [sessionOv, setSessionOv] = useState<Partial<SessionMeta>>({});
  const [playerOv, setPlayerOv] = useState<Record<string, Partial<Player>>>({});
  const [mobOv, setMobOv] = useState<Record<string, Partial<Mob>>>({});
  // Structural optimism: `hidden` drops kicked players / deleted mobs; `admitting` hides a
  // just-admitted joiner from the lobby until the server reflects the promotion.
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [admitting, setAdmitting] = useState<Set<string>>(() => new Set());
  const pending = useRef(0);
  // Serialize sends per target so absolute-value PATCHes land in tap order.
  const chains = useRef<Map<string, Promise<void>>>(new Map());

  useEffect(() => {
    if (pending.current !== 0) return;
    setSessionOv((o) => (Object.keys(o).length ? {} : o));
    setPlayerOv((o) => (Object.keys(o).length ? {} : o));
    setMobOv((o) => (Object.keys(o).length ? {} : o));
    setHidden((prev) => {
      if (!prev.size) return prev;
      const next = new Set<string>();
      for (const id of prev) {
        const stillThere =
          snapshot.players.some(
            (p) => p.id === id && (p.presence === 'admitted' || p.presence === 'pending'),
          ) || snapshot.mobs.some((m) => m.id === id);
        if (stillThere) next.add(id); // server hasn't caught up — keep hiding
      }
      return next.size === prev.size ? prev : next;
    });
    setAdmitting((prev) => {
      if (!prev.size) return prev;
      const next = new Set<string>();
      for (const id of prev) {
        if (snapshot.players.some((p) => p.id === id && p.presence === 'pending')) next.add(id);
      }
      return next.size === prev.size ? prev : next;
    });
  }, [snapshot]);

  const session = { ...snapshot.session, ...sessionOv };
  const players = snapshot.players
    .filter((p) => !hidden.has(p.id))
    .map((p) => (playerOv[p.id] ? { ...p, ...playerOv[p.id] } : p));
  const mobs = snapshot.mobs
    .filter((m) => !hidden.has(m.id))
    .map((m) => (mobOv[m.id] ? { ...m, ...mobOv[m.id] } : m));
  const log = snapshot.log;

  const admitted = players.filter((p) => p.presence === 'admitted');
  const lobby = players.filter((p) => p.presence === 'pending' && !admitting.has(p.id));

  const activePlayers = admitted.filter((p) => p.status === 'active');
  const actedCount = activePlayers.filter((p) => p.actedThisRound).length;

  const nameByIndex = useMemo(() => {
    const m = new Map<number, string>();
    for (const p of snapshot.players) m.set(p.index, p.name);
    return (i: number) => (i === 0 ? 'GM' : (m.get(i) ?? `Player ${i}`));
  }, [snapshot.players]);

  // Sheets / dialogs
  const [condTarget, setCondTarget] = useState<CondTarget | null>(null);
  const [tooltipId, setTooltipId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  // `confirm === 'round'` drives the INLINE round confirm inside the Round Control card;
  // `confirm === 'end'` drives the End-session modal. `ended` shows the farewell overlay.
  const [confirm, setConfirm] = useState<'end' | 'round' | null>(null);
  const [ended, setEnded] = useState(false);

  // --- optimistic plumbing --------------------------------------------------
  function enqueue(key: string, send: () => Promise<void>, revert: () => void) {
    pending.current += 1;
    const prev = chains.current.get(key) ?? Promise.resolve();
    const next = prev.then(async () => {
      try {
        await send();
      } catch {
        revert();
      } finally {
        pending.current -= 1;
        if (pending.current === 0) refresh();
      }
    });
    chains.current.set(key, next);
  }

  function patchSession(optimistic: Partial<SessionMeta>, key: string, send: () => Promise<unknown>) {
    setSessionOv((o) => ({ ...o, ...optimistic }));
    enqueue(
      key,
      async () => {
        await send();
      },
      () => setSessionOv({}),
    );
  }

  function patchPlayer(id: string, patch: Partial<Player>) {
    setPlayerOv((o) => ({ ...o, [id]: { ...o[id], ...patch } }));
    enqueue(
      `player:${id}`,
      async () => {
        await updatePlayer(code, token, id, patch);
      },
      () => setPlayerOv({}),
    );
  }

  function patchMob(id: string, patch: Partial<Mob>) {
    setMobOv((o) => ({ ...o, [id]: { ...o[id], ...patch } }));
    enqueue(
      `mob:${id}`,
      async () => {
        await updateMob(code, token, id, patch);
      },
      () => setMobOv({}),
    );
  }

  // --- session counters -----------------------------------------------------
  const deltaGlory = (d: number) =>
    patchSession({ glory: nextCounter(session.glory, d) }, 'glory', () => adjustGlory(code, token, d));
  const setGlory = (v: number) =>
    patchSession({ glory: Math.max(0, v) }, 'glory', () => updateSession(code, token, { glory: Math.max(0, v) }));
  const deltaRuin = (d: number) =>
    patchSession({ ruin: nextCounter(session.ruin, d) }, 'ruin', () => adjustRuin(code, token, d));
  const setRuin = (v: number) =>
    patchSession({ ruin: Math.max(0, v) }, 'ruin', () => updateSession(code, token, { ruin: Math.max(0, v) }));
  const toggleShowRuin = () =>
    patchSession({ showRuin: !session.showRuin }, 'showRuin', () =>
      updateSession(code, token, { showRuin: !session.showRuin }),
    );

  const doNextRound = () => {
    setConfirm(null);
    setSessionOv((o) => ({ ...o, round: session.round + 1 }));
    setPlayerOv((o) => {
      const n = { ...o };
      for (const p of players) n[p.id] = { ...n[p.id], actedThisRound: false };
      return n;
    });
    setMobOv((o) => {
      const n = { ...o };
      for (const m of mobs) n[m.id] = { ...n[m.id], actedThisRound: false };
      return n;
    });
    enqueue(
      'round',
      async () => {
        await nextRound(code, token);
      },
      () => {
        setSessionOv({});
        setPlayerOv({});
        setMobOv({});
      },
    );
  };

  // --- player overrides -----------------------------------------------------
  const playerActions: PlayerActions = {
    onWounds: (p, d) => {
      const v = clampCurrent(p.wounds + d, p.maxWounds);
      if (v !== p.wounds) patchPlayer(p.id, { wounds: v });
    },
    onShock: (p, d) => {
      const v = clampCurrent(p.shock + d, p.maxShock);
      if (v !== p.shock) patchPlayer(p.id, { shock: v });
    },
    onWrath: (p, d) => {
      const v = clampWrath(p.wrath + d);
      if (v !== p.wrath) patchPlayer(p.id, { wrath: v });
    },
    onStatus: (p, status) => {
      if (status !== p.status) patchPlayer(p.id, { status });
    },
    onActed: (p) => patchPlayer(p.id, { actedThisRound: !p.actedThisRound }),
    onKick: (p) => {
      setHidden((s) => new Set(s).add(p.id));
      void kick(code, p.id, token).then(refresh).catch(() => undefined);
    },
    onOpenConditions: (p) => setCondTarget({ kind: 'player', id: p.id }),
    onRemoveCondition: (p, id) => patchPlayer(p.id, { conditions: withConditionRemoved(p.conditions, id) }),
    onTapCondition: setTooltipId,
  };

  // --- mob overrides --------------------------------------------------------
  const mobActions: MobActions = {
    onHp: (m, d) => {
      const v = clampCurrent(m.hp + d, m.maxHp);
      if (v !== m.hp) patchMob(m.id, { hp: v });
    },
    onKill: (m) => {
      if (m.hp !== 0) patchMob(m.id, { hp: 0 });
    },
    onReveal: (m) => patchMob(m.id, { revealed: !m.revealed }),
    onActed: (m) => patchMob(m.id, { actedThisRound: !m.actedThisRound }),
    onRename: (m, label) => patchMob(m.id, { label }),
    onDuplicate: (m) => {
      void duplicateMob(code, token, m.id).then(refresh).catch(() => undefined);
    },
    onDelete: (m) => {
      setHidden((s) => new Set(s).add(m.id));
      void deleteMob(code, token, m.id).then(refresh).catch(() => undefined);
    },
    onOpenConditions: (m) => setCondTarget({ kind: 'mob', id: m.id }),
    onRemoveCondition: (m, id) => patchMob(m.id, { conditions: withConditionRemoved(m.conditions, id) }),
    onTapCondition: setTooltipId,
  };

  // --- lobby ----------------------------------------------------------------
  const onAdmit = (p: Player) => {
    setAdmitting((s) => new Set(s).add(p.id));
    void admit(code, p.id, token).then(refresh).catch(() => undefined);
  };
  const onIgnore = (p: Player) => {
    setHidden((s) => new Set(s).add(p.id));
    void kick(code, p.id, token).then(refresh).catch(() => undefined);
  };

  // --- shared condition picker (routes to player or mob) --------------------
  const targetEntity = condTarget
    ? condTarget.kind === 'player'
      ? players.find((p) => p.id === condTarget.id)
      : mobs.find((m) => m.id === condTarget.id)
    : undefined;
  const targetName = condTarget
    ? condTarget.kind === 'player'
      ? players.find((p) => p.id === condTarget.id)?.name
      : mobs.find((m) => m.id === condTarget.id)?.label
    : undefined;

  const addConditionToTarget = (id: string) => {
    if (!condTarget || !targetEntity) return;
    const next = withConditionAdded(targetEntity.conditions, id);
    if (!next) return; // already applied & doesn't stack
    if (condTarget.kind === 'player') patchPlayer(condTarget.id, { conditions: next });
    else patchMob(condTarget.id, { conditions: next });
  };

  // --- add-mob / end-session ------------------------------------------------
  const submitAddMobs = async (spec: AddMobsInput) => {
    await addMobs(code, token, spec);
    refresh();
  };
  const confirmEnd = async () => {
    await endSession(code, token);
    setEnded(true); // show the farewell overlay; "start new" navigates via onEnded
  };

  const exportLog = () => {
    const entries = log.map((e) => {
      const v = decodeLog(e);
      return {
        actorIndex: v.actorIndex,
        actor: nameByIndex(v.actorIndex),
        delta: v.delta,
        type: v.type,
        ts: v.ts,
        at: new Date(v.ts * 1000).toISOString(),
        text: formatLog(v, nameByIndex),
      };
    });
    const payload = { code, round: session.round, exportedAt: new Date().toISOString(), entries };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `wg-log-${code}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const tooltipDef = tooltipId ? conditionDef(tooltipId) : undefined;
  const chapterName = session.settings?.chapterName?.trim();

  return (
    <div className="relative min-h-dvh bg-bg">
      {/* Ambient dual radial gradient — gold glow top, dark vignette bottom. */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 z-[1]"
        style={{
          background:
            'radial-gradient(130% 100% at 50% -10%, rgba(240,180,41,0.05), transparent 45%), radial-gradient(120% 90% at 50% 105%, rgba(0,0,0,0.6), transparent 55%)',
        }}
      />

      <div className="relative z-[2] min-h-dvh pb-16">
        {/* Header */}
        <header
          className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-x-5 gap-y-3 border-b border-default px-4 py-4 md:px-6 xl:px-[26px]"
          style={{ background: 'linear-gradient(180deg,#1a150d,#100c07)' }}
        >
          <div className="flex min-w-0 items-baseline gap-4">
            <span className="whitespace-nowrap font-display text-2xl font-bold leading-none tracking-[2px]">
              WRATH <span className="text-gold">&amp;</span> GLORY
            </span>
            <span className="hidden whitespace-nowrap font-body text-[11px] font-medium italic leading-none tracking-[1px] text-muted sm:inline">
              Session Assistant · Game Master&apos;s Console
            </span>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-x-[18px] gap-y-2">
            <div className="flex flex-col items-end gap-1">
              <span className="font-display text-[8px] font-semibold leading-none tracking-[2px] text-muted">
                JOIN CODE
              </span>
              <span className="rounded border border-default bg-panel px-2.5 py-[5px] font-display text-sm font-bold leading-none tracking-[4px] text-gold">
                {code}
              </span>
            </div>

            <FreshnessBadge freshness={freshness} chapterName={chapterName} />

            <button
              type="button"
              onClick={() => setConfirm('end')}
              className="rounded border border-strong bg-transparent px-3 py-[9px] font-display text-[10px] font-semibold leading-none tracking-[1px] text-muted transition-colors hover:border-wounds hover:text-[#ff9498]"
            >
              END SESSION
            </button>
          </div>
        </header>

        {/* Counters row */}
        <div className="grid gap-3.5 px-4 pt-[18px] md:grid-cols-[1.15fr_0.92fr_0.92fr] md:px-6 xl:px-[26px]">
          <RoundControlCard
            round={session.round}
            actedCount={actedCount}
            activeCount={activePlayers.length}
            confirming={confirm === 'round'}
            onAsk={() => setConfirm('round')}
            onConfirm={doNextRound}
            onCancel={() => setConfirm(null)}
          />
          <CounterCard
            label="GLORY"
            note="party · always seen"
            value={session.glory}
            color="var(--color-gold)"
            glow="0 0 26px rgba(240,180,41,0.45)"
            theme="gold"
            hint="tap the number to set a value"
            onDelta={deltaGlory}
            onSet={setGlory}
          />
          <CounterCard
            label="RUIN"
            value={session.ruin}
            color="var(--color-violet)"
            glow="0 0 26px rgba(169,139,255,0.4)"
            theme="ruin"
            labelColor="var(--color-violet)"
            headerAction={<RuinToggle shown={session.showRuin} onToggle={toggleShowRuin} />}
            onDelta={deltaRuin}
            onSet={setRuin}
          />
        </div>

        {/* Main: party roster (fluid) + 384px sidebar */}
        <div className="grid items-start gap-4 px-4 pt-[18px] md:px-6 xl:grid-cols-[minmax(0,1fr)_384px] xl:px-[26px]">
          <PartyRoster players={admitted} actions={playerActions} />

          <div className="flex flex-col gap-4">
            <MobsPanel mobs={mobs} actions={mobActions} onAdd={() => setAddOpen(true)} />
            <LogPanel log={log} nameByIndex={nameByIndex} onExport={exportLog} />
            <LobbyPanel lobby={lobby} onAdmit={onAdmit} onIgnore={onIgnore} />
          </div>
        </div>
      </div>

      {/* ---- Condition picker (shared, player or mob) ---- */}
      <Dialog
        open={condTarget !== null}
        onClose={() => setCondTarget(null)}
        widthClass="max-w-[520px]"
        title={
          <span className="flex flex-col gap-1">
            <span>Add condition</span>
            {targetName && (
              <span className="font-body text-[11px] font-normal italic tracking-normal text-muted">
                to {targetName}
              </span>
            )}
          </span>
        }
      >
        <div className="grid grid-cols-2 gap-2">
          {CONDITIONS.map((def) => {
            const applied = targetEntity?.conditions.find((c) => c.id === def.id);
            const sub = applied
              ? def.stacks && applied.rank
                ? 'Applied · adds a rank'
                : 'Applied'
              : def.stacks
                ? 'Stackable'
                : 'Single';
            return (
              <button
                key={def.id}
                type="button"
                onClick={() => addConditionToTarget(def.id)}
                className="flex flex-col items-start gap-1 rounded-[4px] border px-[11px] py-[9px] text-left transition-colors hover:border-emphasis"
                style={{
                  background: applied ? 'var(--color-raised)' : 'var(--color-bg)',
                  borderColor: applied ? 'var(--color-emphasis)' : 'var(--color-default)',
                }}
              >
                <span className="flex items-center gap-1.5">
                  <span
                    className="size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: chipColor(def.category) }}
                  />
                  <span className="font-display text-[12px] font-semibold leading-none tracking-[0.5px] text-text">
                    {def.name}
                  </span>
                </span>
                <span className="text-[10px] leading-[1.3] text-muted">{sub}</span>
              </button>
            );
          })}
        </div>
      </Dialog>

      {/* ---- Condition tooltip ---- */}
      <Dialog
        open={tooltipId !== null}
        onClose={() => setTooltipId(null)}
        widthClass="max-w-[420px]"
        title={
          tooltipDef ? (
            <span style={{ color: chipColor(tooltipDef.category) }}>{tooltipDef.name}</span>
          ) : (
            'Condition'
          )
        }
      >
        {tooltipDef ? (
          <div className="flex flex-col gap-3">
            <span
              className="inline-flex w-fit items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[1px]"
              style={{ borderColor: chipColor(tooltipDef.category), color: chipColor(tooltipDef.category) }}
            >
              {tooltipDef.category}
              {tooltipDef.stacks ? ' · stacks' : ''}
            </span>
            <p className="text-sm leading-relaxed text-text-2">{tooltipDef.summary}</p>
          </div>
        ) : (
          <p className="text-sm text-muted">No details for &ldquo;{tooltipId}&rdquo;.</p>
        )}
      </Dialog>

      {/* ---- Add-mob dialog ---- */}
      <AddMobDialog open={addOpen} onClose={() => setAddOpen(false)} onSubmit={submitAddMobs} />

      {/* ---- End-session confirm ---- */}
      <EndSessionDialog open={confirm === 'end'} onClose={() => setConfirm(null)} onConfirm={confirmEnd} />

      {/* ---- Ended overlay ---- */}
      {ended && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-6"
          style={{ background: 'var(--color-bg-player)' }}
        >
          <div className="max-w-[420px] text-center">
            <div className="mb-4 font-display text-[13px] font-bold leading-none tracking-[4px] text-muted">
              WRATH <span className="text-gold">&amp;</span> GLORY
            </div>
            <div className="mb-3 font-display text-[30px] font-bold leading-[1.1] tracking-[1px] text-text">
              Session ended
            </div>
            <div className="mb-[26px] text-sm leading-[1.55] text-muted">
              The board has been cleared and the join code retired. The exported log is the only
              record that outlives the session.
            </div>
            <button
              type="button"
              onClick={onEnded}
              className="rounded bg-gold px-[22px] py-3.5 font-display text-[12px] font-bold leading-none tracking-[1.5px] text-on-gold transition-colors hover:bg-gold-hi"
            >
              ▸ START A NEW SESSION
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header freshness
// ---------------------------------------------------------------------------

function FreshnessBadge({ freshness, chapterName }: { freshness: Freshness; chapterName?: string }) {
  const { secondsAgo, updatedAt, error } = freshness;
  const { color, label } = error
    ? { color: 'var(--color-wounds)', label: 'CONNECTION LOST' }
    : updatedAt === null
      ? { color: 'var(--color-minor)', label: 'CONNECTING…' }
      : {
          color:
            secondsAgo <= 6
              ? 'var(--color-status-active)'
              : secondsAgo <= 15
                ? 'var(--color-minor)'
                : 'var(--color-gravely)',
          label: `SYNCED ${secondsAgo}s`,
        };

  return (
    <span className="inline-flex items-center gap-1.5 font-body text-[9px] font-semibold leading-none tracking-[1px] text-muted">
      <span
        className={cn('size-2 rounded-full', updatedAt === null && !error && 'animate-pulse')}
        style={{ background: color, boxShadow: `0 0 8px ${color}` }}
        aria-hidden
      />
      {chapterName ? `${chapterName} · ${label}` : label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

function RoundControlCard({
  round,
  actedCount,
  activeCount,
  confirming,
  onAsk,
  onConfirm,
  onCancel,
}: {
  round: number;
  actedCount: number;
  activeCount: number;
  confirming: boolean;
  onAsk: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex flex-col rounded-md border border-default bg-panel px-[17px] py-[15px]">
      <div className="mb-2.5 font-display text-[10px] font-semibold leading-none tracking-[3px] text-muted">
        <span className="text-gold">◆</span> ROUND CONTROL
      </div>
      <div className="flex flex-wrap items-baseline gap-3">
        <span className="whitespace-nowrap font-display text-[34px] font-bold leading-none text-text">
          ROUND {round}
        </span>
        <span className="font-body text-xs font-medium italic leading-none text-muted">
          {actedCount} of {activeCount} acted
        </span>
      </div>
      <div className="mt-3.5">
        {confirming ? (
          <div className="flex flex-wrap items-center gap-[9px]">
            <span className="text-[11px] leading-[1.3] text-text-2">
              Reset every hero&apos;s <b className="text-text">Acted</b> flag?
            </span>
            <button
              type="button"
              onClick={onConfirm}
              className="rounded-[3px] bg-gold px-[13px] py-[9px] font-display text-[10px] font-bold leading-none tracking-[1px] text-on-gold transition-colors hover:bg-gold-hi"
            >
              CONFIRM
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="rounded-[3px] border border-default bg-transparent px-[13px] py-[9px] font-display text-[10px] font-semibold leading-none tracking-[1px] text-muted transition-colors hover:border-emphasis hover:text-text"
            >
              CANCEL
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={onAsk}
            className="rounded bg-gold px-[18px] py-3 font-display text-[12px] font-bold leading-none tracking-[1.5px] text-on-gold transition-colors hover:bg-gold-hi"
          >
            ▸ NEXT ROUND
          </button>
        )}
      </div>
    </div>
  );
}

function CounterCard({
  label,
  note,
  value,
  color,
  glow,
  theme,
  labelColor,
  hint,
  headerAction,
  onDelta,
  onSet,
}: {
  label: string;
  note?: string;
  value: number;
  color: string;
  glow: string;
  theme: 'gold' | 'ruin';
  labelColor?: string;
  hint?: string;
  headerAction?: ReactNode;
  onDelta: (d: number) => void;
  onSet: (v: number) => void;
}) {
  return (
    <div className="rounded-md border border-default bg-panel px-[17px] py-[15px]">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span
          className="font-display text-[11px] font-semibold leading-none tracking-[2px]"
          style={{ color: labelColor ?? 'var(--color-gold)' }}
        >
          {label}
        </span>
        {headerAction ??
          (note ? (
            <span className="font-body text-[9px] font-medium italic leading-none text-muted">{note}</span>
          ) : null)}
      </div>
      <div className="flex items-center justify-between gap-3">
        <EditableNumber
          value={value}
          onCommit={onSet}
          ariaLabel={`Set ${label}`}
          color={color}
          glow={glow}
          viewClassName="cursor-pointer font-display text-[52px] font-bold leading-none tabular-nums transition-opacity hover:opacity-80"
          inputClassName="w-[92px] rounded border border-emphasis bg-bg py-1 text-center font-display text-[40px] font-bold leading-none tabular-nums outline-none"
        />
        <div className="flex flex-col gap-[7px]">
          <CounterStep sign="+" theme={theme} onClick={() => onDelta(1)} />
          <CounterStep sign="−" theme={theme} onClick={() => onDelta(-1)} disabled={value <= 0} />
        </div>
      </div>
      {hint && (
        <div className="mt-2 font-body text-[8px] font-medium leading-none tracking-[0.5px] text-faint">
          {hint}
        </div>
      )}
    </div>
  );
}

function CounterStep({
  sign,
  theme,
  onClick,
  disabled,
}: {
  sign: '+' | '−';
  theme: 'gold' | 'ruin';
  onClick: () => void;
  disabled?: boolean;
}) {
  const solid = sign === '+';
  const base =
    'grid h-[34px] w-11 place-items-center rounded-[3px] font-display text-[17px] font-bold leading-none transition-colors disabled:opacity-40';
  if (solid && theme === 'gold') {
    return (
      <button type="button" onClick={onClick} disabled={disabled} className={cn(base, 'bg-gold text-on-gold hover:enabled:bg-gold-hi')}>
        {sign}
      </button>
    );
  }
  if (solid && theme === 'ruin') {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={cn(base, 'border text-text hover:enabled:border-violet')}
        style={{ background: '#2a2140', borderColor: '#4a3d6e' }}
      >
        {sign}
      </button>
    );
  }
  // ghost minus (both themes)
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        base,
        'border border-emphasis bg-transparent text-text-2',
        theme === 'ruin' ? 'hover:enabled:border-violet hover:enabled:text-text' : 'hover:enabled:border-gold hover:enabled:text-text',
      )}
    >
      {sign}
    </button>
  );
}

function RuinToggle({ shown, onToggle }: { shown: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="rounded-[3px] border px-[7px] py-[5px] font-display text-[8px] font-semibold leading-none tracking-[1px] transition-colors"
      style={
        shown
          ? {
              color: 'var(--color-violet)',
              background: alpha('var(--color-violet)', 14),
              borderColor: alpha('var(--color-violet)', 45),
            }
          : { color: 'var(--color-muted)', background: 'transparent', borderColor: 'var(--color-default)' }
      }
    >
      {shown ? '👁 SHOWN' : 'HIDDEN'}
    </button>
  );
}

/** Click-to-set number: renders a button that swaps to an input on click. */
function EditableNumber({
  value,
  onCommit,
  ariaLabel,
  color,
  glow,
  viewClassName,
  inputClassName,
}: {
  value: number;
  onCommit: (v: number) => void;
  ariaLabel: string;
  color?: string;
  glow?: string;
  viewClassName?: string;
  inputClassName?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  if (!editing) {
    return (
      <button
        type="button"
        aria-label={ariaLabel}
        onClick={() => {
          setDraft(String(value));
          setEditing(true);
        }}
        className={viewClassName}
        style={{ color, textShadow: glow }}
      >
        {value}
      </button>
    );
  }

  const commit = () => {
    setEditing(false);
    const n = Number.parseInt(draft, 10);
    if (Number.isFinite(n) && n !== value) onCommit(Math.max(0, n));
  };

  return (
    <input
      type="number"
      inputMode="numeric"
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        else if (e.key === 'Escape') setEditing(false);
      }}
      aria-label={ariaLabel}
      className={inputClassName}
      style={{ color }}
    />
  );
}

// ---------------------------------------------------------------------------
// Party roster
// ---------------------------------------------------------------------------

interface PlayerActions {
  onWounds: (p: Player, d: number) => void;
  onShock: (p: Player, d: number) => void;
  onWrath: (p: Player, d: number) => void;
  onStatus: (p: Player, s: PlayerStatus) => void;
  onActed: (p: Player) => void;
  onKick: (p: Player) => void;
  onOpenConditions: (p: Player) => void;
  onRemoveCondition: (p: Player, id: string) => void;
  onTapCondition: (id: string) => void;
}

function PartyRoster({ players, actions }: { players: Player[]; actions: PlayerActions }) {
  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <span className="font-display text-[11px] font-semibold leading-none tracking-[3px] text-muted">
          <span className="text-gold">◆</span> PARTY ROSTER
        </span>
        <span className="font-body text-[11px] font-medium italic leading-none text-muted">
          {players.length} {players.length === 1 ? 'hero' : 'heroes'} · you override any hero
        </span>
      </div>
      {players.length === 0 ? (
        <p className="font-body text-[13px] italic text-faint">No heroes admitted yet.</p>
      ) : (
        <div
          className="grid gap-3"
          style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 332px), 1fr))' }}
        >
          {players.map((p) => (
            <PlayerCard key={p.id} p={p} actions={actions} />
          ))}
        </div>
      )}
    </section>
  );
}

function PlayerCard({ p, actions }: { p: Player; actions: PlayerActions }) {
  const dead = p.status === 'dead';
  const nameColor = dead ? 'var(--color-muted)' : 'var(--color-text)';
  const woundPct = p.maxWounds > 0 ? Math.round((p.wounds / p.maxWounds) * 100) : 0;
  const shockPct = p.maxShock > 0 ? Math.round((p.shock / p.maxShock) * 100) : 0;

  return (
    <div
      className="rounded-[5px] border border-default bg-panel px-3.5 py-[13px]"
      style={{
        borderLeft: `3px solid ${statusColor(p.status)}`,
        opacity: dead ? 0.55 : 1,
      }}
    >
      {/* header */}
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 rounded-[3px] border border-default px-[5px] py-[3px] text-[9px] font-semibold leading-none text-muted">
            P{p.index}
          </span>
          <span
            className="truncate font-display text-base font-semibold leading-[1.1] tracking-[0.5px]"
            style={{ color: nameColor, textDecoration: dead ? 'line-through' : 'none' }}
          >
            {p.name}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {p.status === 'active' && <ActedButton acted={p.actedThisRound} onClick={() => actions.onActed(p)} />}
          <StatusSelect value={p.status} onChange={(s) => actions.onStatus(p, s)} />
          <button
            type="button"
            aria-label={`Kick ${p.name}`}
            title={`Kick ${p.name}`}
            onClick={() => actions.onKick(p)}
            className="px-[3px] font-body text-[13px] font-semibold leading-none text-faint transition-colors hover:text-[#ff9498]"
          >
            ×
          </button>
        </div>
      </div>

      {/* wounds */}
      <StatRow
        label="WOUNDS"
        text={`${p.wounds} / ${p.maxWounds}`}
        color="var(--color-wounds)"
        pct={woundPct}
        numWidth="50px"
        onDec={() => actions.onWounds(p, -1)}
        onInc={() => actions.onWounds(p, 1)}
      />

      {/* shock */}
      <div className="mt-[9px]">
        <StatRow
          label="SHOCK"
          text={`${p.shock} / ${p.maxShock}`}
          color="var(--color-shock)"
          pct={shockPct}
          numWidth="46px"
          onDec={() => actions.onShock(p, -1)}
          onInc={() => actions.onShock(p, 1)}
        />
      </div>

      {/* wrath + conditions */}
      <div className="mt-[13px] flex items-center justify-between gap-2.5">
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-[9px] font-semibold leading-none tracking-[1px] text-muted">WRATH</span>
          <ValueStepper onDec={() => actions.onWrath(p, -1)} onInc={() => actions.onWrath(p, 1)}>
            <span
              className="min-w-[24px] px-2.5 text-center font-display text-sm font-bold leading-none"
              style={{ color: 'var(--color-wrath)' }}
            >
              {p.wrath}
            </span>
          </ValueStepper>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-[5px]">
          {p.conditions.map((c, i) => (
            <CondChip
              key={c.id + i}
              applied={c}
              onTap={() => actions.onTapCondition(c.id)}
              onRemove={() => actions.onRemoveCondition(p, c.id)}
            />
          ))}
          <AddCondButton compact onClick={() => actions.onOpenConditions(p)} />
        </div>
      </div>
    </div>
  );
}

function StatRow({
  label,
  text,
  color,
  pct,
  numWidth,
  onDec,
  onInc,
}: {
  label: string;
  text: string;
  color: string;
  pct: number;
  numWidth: string;
  onDec: () => void;
  onInc: () => void;
}) {
  return (
    <div>
      <div className="mb-[5px] flex items-center justify-between">
        <span className="text-[9px] font-semibold leading-none tracking-[1px] text-muted">{label}</span>
        <ValueStepper onDec={onDec} onInc={onInc}>
          <span
            className="px-2 text-center font-display text-[12px] font-semibold leading-none"
            style={{ color, minWidth: numWidth }}
          >
            {text}
          </span>
        </ValueStepper>
      </div>
      <div className="h-2 overflow-hidden rounded-[2px] border border-default bg-track">
        <div className="h-full" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

function StatusSelect({ value, onChange }: { value: PlayerStatus; onChange: (s: PlayerStatus) => void }) {
  return (
    <select
      aria-label="Status"
      value={value}
      onChange={(e) => onChange(e.target.value as PlayerStatus)}
      className="rounded-[3px] border border-default bg-raised px-1.5 py-1.5 font-display text-[9px] font-semibold uppercase leading-none tracking-[1px] outline-none"
      style={{ color: statusColor(value) }}
    >
      {STATUSES.map((s) => (
        <option key={s} value={s} className="bg-panel text-text">
          {statusLabel(s).toUpperCase()}
        </option>
      ))}
    </select>
  );
}

// ---------------------------------------------------------------------------
// Mobs
// ---------------------------------------------------------------------------

interface MobActions {
  onHp: (m: Mob, d: number) => void;
  onKill: (m: Mob) => void;
  onReveal: (m: Mob) => void;
  onActed: (m: Mob) => void;
  onRename: (m: Mob, label: string) => void;
  onDuplicate: (m: Mob) => void;
  onDelete: (m: Mob) => void;
  onOpenConditions: (m: Mob) => void;
  onRemoveCondition: (m: Mob, id: string) => void;
  onTapCondition: (id: string) => void;
}

function MobsPanel({ mobs, actions, onAdd }: { mobs: Mob[]; actions: MobActions; onAdd: () => void }) {
  return (
    <Panel
      title="MOBS"
      meta={`${mobs.length} on board`}
      action={
        <button
          type="button"
          onClick={onAdd}
          className="rounded-[3px] border border-strong bg-transparent px-[9px] py-1.5 font-display text-[9px] font-semibold leading-none tracking-[1px] text-gold transition-colors hover:border-gold"
        >
          + ADD
        </button>
      }
    >
      {mobs.length === 0 ? (
        <p className="font-body text-[12px] italic text-faint">No mobs on the board.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {mobs.map((m) => (
            <MobRow key={m.id} m={m} actions={actions} />
          ))}
        </div>
      )}
    </Panel>
  );
}

function MobRow({ m, actions }: { m: Mob; actions: MobActions }) {
  const c = coarse(m.hp, m.maxHp);
  const color = coarseColor(c);
  const dead = c === 'dead';
  const hidden = !m.revealed;

  return (
    <div
      className="rounded-[4px] px-[11px] py-2.5"
      style={{
        background: hidden ? '#120f09' : 'var(--color-panel)',
        border: hidden ? '1px dashed var(--color-strong)' : '1px solid var(--color-default)',
        borderLeft: `3px solid ${color}`,
        opacity: dead ? 0.62 : 1,
      }}
    >
      {/* identity + hp stepper */}
      <div className="flex items-center gap-[9px]">
        <span className="inline-flex shrink-0">
          <CoarseIcon coarse={c} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <InlineName name={m.label} dead={dead} onCommit={(v) => actions.onRename(m, v)} />
            <span
              className="shrink-0 rounded-[2px] border px-1 py-0.5 font-display text-[8px] font-semibold leading-none tracking-[1px]"
              style={{ color: tierColor(m.tier), borderColor: alpha(tierColor(m.tier), 33) }}
            >
              {m.tier}
            </span>
            {hidden && (
              <span className="shrink-0 rounded-[2px] border border-dashed border-strong px-[5px] py-0.5 font-display text-[8px] font-semibold leading-none tracking-[1px] text-muted">
                HIDDEN
              </span>
            )}
          </div>
          <div className="mt-1 flex items-center gap-2">
            <span
              className="font-display text-[9px] font-semibold uppercase leading-none tracking-[1px]"
              style={{ color }}
            >
              {coarseLabel(c)}
            </span>
            <span className="font-body text-[10px] font-semibold leading-none text-faint">
              {m.hp} / {m.maxHp} HP
            </span>
          </div>
        </div>
        <div className="inline-flex shrink-0 items-center overflow-hidden rounded-[3px] border border-default">
          <button
            type="button"
            aria-label="Decrease HP"
            onClick={() => actions.onHp(m, -1)}
            className="bg-raised px-2 py-1 font-display text-[12px] font-semibold leading-none text-text-2 transition-colors hover:text-text"
          >
            −
          </button>
          <button
            type="button"
            aria-label="Increase HP"
            onClick={() => actions.onHp(m, 1)}
            className="border-l border-default bg-raised px-2 py-1 font-display text-[12px] font-semibold leading-none text-text-2 transition-colors hover:text-text"
          >
            +
          </button>
        </div>
      </div>

      {/* action row */}
      <div className="mt-[9px] flex flex-wrap items-center gap-1.5">
        {!dead && <ActedButton acted={m.actedThisRound} onClick={() => actions.onActed(m)} />}
        <button
          type="button"
          onClick={() => actions.onReveal(m)}
          className="rounded-[3px] px-[9px] py-1.5 font-display text-[9px] font-semibold leading-none tracking-[0.5px] transition-colors"
          style={
            m.revealed
              ? { color: 'var(--color-muted)', background: 'transparent', border: '1px solid var(--color-default)' }
              : { color: 'var(--color-on-gold)', background: 'var(--color-gold)', border: 'none' }
          }
        >
          {m.revealed ? 'HIDE' : 'REVEAL'}
        </button>
        <button
          type="button"
          onClick={() => actions.onDuplicate(m)}
          className="rounded-[3px] border border-default bg-transparent px-[9px] py-1.5 font-display text-[9px] font-semibold leading-none tracking-[0.5px] text-muted transition-colors hover:border-emphasis hover:text-text"
        >
          DUPLICATE
        </button>
        <button
          type="button"
          onClick={() => actions.onKill(m)}
          className="rounded-[3px] border border-default bg-transparent px-[9px] py-1.5 font-display text-[9px] font-semibold leading-none tracking-[0.5px] text-muted transition-colors hover:border-wounds hover:text-[#ff9498]"
        >
          KILL
        </button>
        <button
          type="button"
          aria-label={`Remove ${m.label}`}
          title="Remove"
          onClick={() => actions.onDelete(m)}
          className="ml-auto px-[5px] py-0.5 font-body text-[12px] font-semibold leading-none text-faint transition-colors hover:text-[#ff9498]"
        >
          ×
        </button>
      </div>

      {/* conditions */}
      <div className="mt-2 flex flex-wrap items-center gap-[5px]">
        {m.conditions.map((c2, i) => (
          <CondChip
            key={c2.id + i}
            applied={c2}
            size="sm"
            onTap={() => actions.onTapCondition(c2.id)}
            onRemove={() => actions.onRemoveCondition(m, c2.id)}
          />
        ))}
        <AddCondButton onClick={() => actions.onOpenConditions(m)} />
      </div>
    </div>
  );
}

/** Inline rename: click the label to edit; Enter/blur commits, Esc cancels. */
function InlineName({ name, dead, onCommit }: { name: string; dead: boolean; onCommit: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  if (!editing) {
    return (
      <button
        type="button"
        title="Click to rename"
        onClick={() => {
          setDraft(name);
          setEditing(true);
        }}
        className="min-w-0 truncate text-left text-[13px] font-semibold leading-[1.1] transition-colors hover:text-gold"
        style={{ color: dead ? 'var(--color-muted)' : 'var(--color-text)', textDecoration: dead ? 'line-through' : 'none' }}
      >
        {name}
      </button>
    );
  }

  const commit = () => {
    setEditing(false);
    const v = draft.trim();
    if (v && v !== name) onCommit(v);
  };

  return (
    <input
      autoFocus
      value={draft}
      maxLength={MOB_LABEL_MAX}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        else if (e.key === 'Escape') setEditing(false);
      }}
      aria-label="Rename mob"
      className="w-[150px] max-w-full rounded-[3px] border border-emphasis bg-bg px-1.5 py-[3px] text-[13px] font-semibold leading-[1.1] text-text outline-none"
    />
  );
}

function CoarseIcon({ coarse }: { coarse: CoarseHp }) {
  const color = coarseColor(coarse);
  const svg = { flexShrink: 0, color } as const;
  if (coarse === 'healthy') {
    return (
      <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden style={svg}>
        <circle cx="8" cy="8" r="6" fill="currentColor" />
      </svg>
    );
  }
  if (coarse === 'minor') {
    return (
      <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden style={svg}>
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M8 2.5 A5.5 5.5 0 0 1 8 13.5 Z" fill="currentColor" />
      </svg>
    );
  }
  if (coarse === 'gravely') {
    return (
      <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden style={svg}>
        <path d="M8 2.2 L14.4 13.2 H1.6 Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        <line x1="8" y1="6.2" x2="8" y2="9.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <circle cx="8" cy="11.4" r="0.9" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden style={svg}>
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <line x1="5.6" y1="5.6" x2="10.4" y2="10.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="10.4" y1="5.6" x2="5.6" y2="10.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Activity log
// ---------------------------------------------------------------------------

function LogPanel({
  log,
  nameByIndex,
  onExport,
}: {
  log: GmSnapshot['log'];
  nameByIndex: (i: number) => string;
  onExport: () => void;
}) {
  return (
    <Panel
      title="ACTIVITY LOG"
      action={
        <button
          type="button"
          onClick={onExport}
          disabled={log.length === 0}
          className="rounded-[3px] border border-strong bg-transparent px-[9px] py-1.5 font-display text-[9px] font-semibold leading-none tracking-[1px] text-muted transition-colors hover:border-gold hover:text-gold disabled:opacity-40"
        >
          ↓ EXPORT
        </button>
      }
    >
      {log.length === 0 ? (
        <p className="font-body text-[12px] italic text-faint">No activity yet.</p>
      ) : (
        <div className="flex max-h-[220px] flex-col gap-0.5 overflow-y-auto">
          {log
            .map((e) => decodeLog(e))
            .map((v, i) => ({ v, key: i }))
            .reverse()
            .map(({ v, key }) => (
              <div key={key} className="flex items-center gap-[9px] border-b border-[#241d12] px-1 py-[7px]">
                <span
                  className="size-[7px] shrink-0 rounded-full"
                  style={{ background: v.type === 'G' ? 'var(--color-gold)' : 'var(--color-violet)' }}
                />
                <span className="flex-1 font-body text-[12px] leading-[1.35] text-text-2">
                  {formatLog(v, nameByIndex)}
                </span>
                <span className="shrink-0 font-body text-[10px] font-medium italic leading-none tabular-nums text-faint">
                  {fmtTime(v.ts)}
                </span>
              </div>
            ))}
        </div>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Lobby
// ---------------------------------------------------------------------------

function LobbyPanel({
  lobby,
  onAdmit,
  onIgnore,
}: {
  lobby: Player[];
  onAdmit: (p: Player) => void;
  onIgnore: (p: Player) => void;
}) {
  return (
    <Panel title="LOBBY" meta={lobby.length === 0 ? 'nobody waiting' : `${lobby.length} waiting`}>
      {lobby.length === 0 ? (
        <p className="font-body text-[12px] italic text-faint">No one waiting to be admitted.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {lobby.map((p) => (
            <div
              key={p.id}
              className="flex items-center justify-between gap-2 rounded-[4px] border border-default bg-raised px-[11px] py-[9px]"
            >
              <span className="truncate font-body text-[13px] font-semibold leading-none text-text">{p.name}</span>
              <div className="flex shrink-0 gap-1.5">
                <button
                  type="button"
                  onClick={() => onAdmit(p)}
                  className="rounded-[3px] px-[11px] py-[7px] font-display text-[9px] font-bold leading-none tracking-[0.5px]"
                  style={{ background: 'var(--color-status-active)', color: 'var(--color-on-gold)' }}
                >
                  ADMIT
                </button>
                <button
                  type="button"
                  onClick={() => onIgnore(p)}
                  className="rounded-[3px] border border-default bg-transparent px-[11px] py-[7px] font-display text-[9px] font-semibold leading-none tracking-[0.5px] text-muted transition-colors hover:border-wounds hover:text-[#ff9498]"
                >
                  IGNORE
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Add-mob dialog
// ---------------------------------------------------------------------------

function AddMobDialog({
  open,
  onClose,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (spec: AddMobsInput) => Promise<void>;
}) {
  const [label, setLabel] = useState<string>(DEFAULTS.mob.label);
  const [tier, setTier] = useState<MobTier>(DEFAULTS.mob.tier);
  const [maxHp, setMaxHp] = useState<number>(DEFAULTS.mob.maxHp);
  const [count, setCount] = useState<number>(DEFAULTS.mob.count);
  const [startsHidden, setStartsHidden] = useState<boolean>(DEFAULTS.mob.startsHidden);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLabel(DEFAULTS.mob.label);
    setTier(DEFAULTS.mob.tier);
    setMaxHp(DEFAULTS.mob.maxHp);
    setCount(DEFAULTS.mob.count);
    setStartsHidden(DEFAULTS.mob.startsHidden);
    setBusy(false);
    setError(null);
  }, [open]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        label: label.trim() || DEFAULTS.mob.label,
        tier,
        maxHp: Math.max(LIMITS.mobMaxHp.min, maxHp),
        count,
        startsHidden,
      });
      onClose();
    } catch {
      setError('Could not add mobs. Try again.');
      setBusy(false);
    }
  };

  const stepClass =
    'grid h-8 w-[34px] shrink-0 place-items-center rounded-[3px] border border-default bg-raised font-display text-base font-semibold leading-none text-text-2 transition-colors hover:enabled:text-text disabled:opacity-40';

  return (
    <Dialog
      open={open}
      onClose={onClose}
      widthClass="max-w-[440px]"
      title={
        <span className="flex flex-col gap-1">
          <span>Add mobs to the board</span>
          <span className="font-body text-[11px] font-normal italic tracking-normal text-muted">
            Drop in a single foe or a whole pack
          </span>
        </span>
      }
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded border border-default bg-transparent px-4 py-2.5 font-display text-[11px] font-semibold leading-none tracking-[0.5px] text-muted transition-colors hover:border-emphasis hover:text-text disabled:opacity-50"
          >
            CANCEL
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            className="rounded bg-gold px-[18px] py-2.5 font-display text-[11px] font-bold leading-none tracking-[1px] text-on-gold transition-colors hover:bg-gold-hi disabled:opacity-50"
          >
            {busy ? 'Adding…' : count > 1 ? `▸ ADD ${count} MOBS` : '▸ ADD TO BOARD'}
          </button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-[7px]">
          <FieldLabel>NAME</FieldLabel>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={MOB_LABEL_MAX}
            autoFocus
            placeholder="e.g. Grotesk Blob"
            className="rounded border border-default bg-bg px-3 py-2.5 text-sm text-text outline-none placeholder:text-faint focus-visible:border-emphasis"
          />
          <span className="font-body text-[10px] italic leading-[1.35] text-faint">
            Use a description if the party hasn&apos;t identified it yet — rename it later.
          </span>
        </label>

        <div className="flex flex-col gap-[7px]">
          <FieldLabel>TIER</FieldLabel>
          <div className="flex gap-2">
            {TIERS.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTier(t)}
                className={cn(
                  'flex-1 rounded border px-1.5 py-[9px] font-display text-[10px] font-semibold leading-none tracking-[1px] transition-colors',
                  tier === t
                    ? 'border-gold bg-gold text-on-gold'
                    : 'border-default bg-transparent text-muted hover:border-emphasis hover:text-text',
                )}
              >
                {t.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        <div className="flex gap-3.5">
          <div className="flex min-w-0 flex-1 flex-col gap-[7px]">
            <FieldLabel>MAX HP</FieldLabel>
            <div className="flex items-center gap-1.5 rounded border border-default bg-bg p-1">
              <button
                type="button"
                aria-label="Decrease max HP"
                onClick={() => setMaxHp((v) => Math.max(LIMITS.mobMaxHp.min, v - 1))}
                disabled={maxHp <= LIMITS.mobMaxHp.min}
                className={stepClass}
              >
                −
              </button>
              <input
                type="number"
                inputMode="numeric"
                min={LIMITS.mobMaxHp.min}
                value={maxHp}
                onChange={(e) =>
                  setMaxHp(
                    Math.max(LIMITS.mobMaxHp.min, Number.parseInt(e.target.value, 10) || LIMITS.mobMaxHp.min),
                  )
                }
                className="min-w-0 flex-1 bg-transparent text-center font-display text-[17px] font-bold leading-none text-text outline-none"
              />
              <button
                type="button"
                aria-label="Increase max HP"
                onClick={() => setMaxHp((v) => v + 1)}
                className={stepClass}
              >
                +
              </button>
            </div>
          </div>

          <div className="flex min-w-0 flex-1 flex-col gap-[7px]">
            <FieldLabel>HOW MANY?</FieldLabel>
            <div className="flex items-center gap-1.5 rounded border border-default bg-bg p-1">
              <button
                type="button"
                aria-label="Fewer"
                onClick={() => setCount((v) => Math.max(LIMITS.addMobCount.min, v - 1))}
                disabled={count <= LIMITS.addMobCount.min}
                className={stepClass}
              >
                −
              </button>
              <span className="min-w-0 flex-1 text-center font-display text-[17px] font-bold leading-none text-text">
                {count}
              </span>
              <button
                type="button"
                aria-label="More"
                onClick={() => setCount((v) => Math.min(LIMITS.addMobCount.max, v + 1))}
                disabled={count >= LIMITS.addMobCount.max}
                className={stepClass}
              >
                +
              </button>
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setStartsHidden((v) => !v)}
          className="flex w-full items-center gap-2.5 rounded border px-3 py-[11px] text-left transition-colors"
          style={{
            background: startsHidden ? alpha('var(--color-gold)', 8) : 'var(--color-bg)',
            borderColor: startsHidden ? 'var(--color-emphasis)' : 'var(--color-default)',
          }}
        >
          <span
            className="grid size-5 shrink-0 place-items-center rounded-[4px] border"
            style={{
              background: startsHidden ? 'var(--color-gold)' : 'transparent',
              borderColor: startsHidden ? 'var(--color-gold)' : 'var(--color-emphasis)',
            }}
          >
            {startsHidden && (
              <span className="font-display text-[12px] font-bold leading-none text-on-gold">✓</span>
            )}
          </span>
          <span className="flex flex-col gap-[3px]">
            <span className="text-[12px] font-semibold leading-none text-text">Starts hidden from players</span>
            <span className="font-body text-[10px] italic leading-[1.35] text-faint">
              Only you see it until you reveal it. Recommended.
            </span>
          </span>
        </button>

        {error && <p className="text-sm text-wounds">{error}</p>}
      </div>
    </Dialog>
  );
}

function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <span className="font-display text-[9px] font-semibold leading-none tracking-[2px] text-muted">
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// End-session dialog
// ---------------------------------------------------------------------------

function EndSessionDialog({
  open,
  onClose,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setBusy(false);
      setError(null);
    }
  }, [open]);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch {
      setError('Something went wrong. Try again.');
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      widthClass="max-w-[400px]"
      title="End this session?"
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded border border-default bg-transparent px-4 py-2.5 font-display text-[11px] font-semibold leading-none tracking-[0.5px] text-muted transition-colors hover:border-emphasis hover:text-text disabled:opacity-50"
          >
            CANCEL
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={busy}
            className="rounded bg-[#c02a2f] px-4 py-2.5 font-display text-[11px] font-bold leading-none tracking-[0.5px] text-white transition-colors hover:bg-[#d8353b] disabled:opacity-50"
          >
            {busy ? 'Ending…' : 'END SESSION'}
          </button>
        </div>
      }
    >
      <p className="text-[13px] leading-[1.5] text-text-2">
        The board clears for every player and the join code stops working. Export the activity log
        first if you want to keep it.
      </p>
      {error && <p className="mt-2 text-sm text-wounds">{error}</p>}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

function Panel({
  title,
  meta,
  action,
  children,
}: {
  title: string;
  meta?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-md border border-default bg-panel px-4 py-[15px]">
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="font-display text-[10px] font-semibold leading-none tracking-[2px] text-muted">
          <span className="text-gold">◆</span> {title}
          {meta && (
            <span className="ml-1 font-body text-[10px] font-medium italic tracking-normal text-faint">
              · {meta}
            </span>
          )}
        </span>
        {action}
      </div>
      {children}
    </section>
  );
}

function ValueStepper({ children, onDec, onInc }: { children: ReactNode; onDec: () => void; onInc: () => void }) {
  return (
    <div className="inline-flex items-center overflow-hidden rounded-[3px] border border-default">
      <button
        type="button"
        aria-label="Decrease"
        onClick={onDec}
        className="bg-raised px-[9px] py-[3px] font-display text-[13px] font-semibold leading-none text-text-2 transition-colors hover:text-text"
      >
        −
      </button>
      {children}
      <button
        type="button"
        aria-label="Increase"
        onClick={onInc}
        className="bg-raised px-[9px] py-[3px] font-display text-[13px] font-semibold leading-none text-text-2 transition-colors hover:text-text"
      >
        +
      </button>
    </div>
  );
}

function ActedButton({ acted, onClick }: { acted: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'whitespace-nowrap rounded-[3px] border px-2 py-1.5 font-display text-[9px] leading-none tracking-[0.5px]',
        acted ? 'font-bold' : 'font-semibold',
      )}
      style={
        acted
          ? {
              color: 'var(--color-status-active)',
              background: alpha('var(--color-status-active)', 14),
              borderColor: alpha('var(--color-status-active)', 45),
            }
          : { color: 'var(--color-muted)', background: 'transparent', borderColor: 'var(--color-default)' }
      }
    >
      {acted ? '✓ ACTED' : 'NOT YET'}
    </button>
  );
}

function AddCondButton({ onClick, compact }: { onClick: () => void; compact?: boolean }) {
  if (compact) {
    return (
      <button
        type="button"
        title="Add condition"
        onClick={onClick}
        className="grid size-6 place-items-center rounded-[3px] border border-dashed border-strong font-display text-[13px] font-semibold leading-none text-muted transition-colors hover:border-gold hover:text-gold"
      >
        +
      </button>
    );
  }
  return (
    <button
      type="button"
      title="Add condition"
      onClick={onClick}
      className="rounded-[3px] border border-dashed border-strong px-2 py-[5px] font-display text-[10px] font-semibold leading-none tracking-[0.5px] text-muted transition-colors hover:border-gold hover:text-gold"
    >
      + COND
    </button>
  );
}

function CondChip({
  applied,
  size,
  onTap,
  onRemove,
}: {
  applied: AppliedCondition;
  size?: 'sm';
  onTap: () => void;
  onRemove: () => void;
}) {
  const def = conditionDef(applied.id);
  const name = def?.name ?? applied.id;
  const color = def ? chipColor(def.category) : 'var(--color-muted)';
  const showRank = !!(applied.rank && applied.rank > 1);
  const sm = size === 'sm';
  return (
    <span
      className={cn('inline-flex items-center gap-1 rounded-[3px] border font-semibold', sm ? 'text-[9px]' : 'text-[10px]')}
      style={{
        color,
        borderColor: alpha(color, 50),
        background: alpha(color, 16),
        padding: sm ? '3px 4px 3px 6px' : '4px 3px 4px 7px',
      }}
    >
      <button type="button" onClick={onTap} className="max-w-[9rem] truncate leading-none">
        {name}
      </button>
      {showRank && (
        <span
          className="rounded-[2px] px-1 py-0.5 font-display text-[8px] font-bold leading-none"
          style={{ background: alpha(color, 30), color }}
        >
          {applied.rank}
        </span>
      )}
      <button
        type="button"
        aria-label={`Remove ${name}`}
        onClick={onRemove}
        className="pl-0.5 pr-px leading-none opacity-65 transition-opacity hover:opacity-100"
      >
        ×
      </button>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Add a condition, honoring stacking (returns null when it's a no-op). */
function withConditionAdded(list: AppliedCondition[], id: string): AppliedCondition[] | null {
  const def = conditionDef(id);
  const existing = list.find((c) => c.id === id);
  if (existing) {
    if (!def?.stacks) return null;
    return list.map((c) => (c.id === id ? { ...c, rank: (c.rank ?? 1) + 1 } : c));
  }
  return [...list, def?.stacks ? { id, rank: 1 } : { id }];
}

function withConditionRemoved(list: AppliedCondition[], id: string): AppliedCondition[] {
  return list.filter((c) => c.id !== id);
}

function fmtTime(tsSeconds: number): string {
  return new Date(tsSeconds * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
