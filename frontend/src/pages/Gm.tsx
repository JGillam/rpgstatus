import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import type {
  AppliedCondition,
  CoarseHp,
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
  Check,
  ChevronsRight,
  Copy,
  Download,
  Eye,
  EyeOff,
  Heart,
  HeartCrack,
  Minus,
  Plus,
  Power,
  ScrollText,
  ShieldAlert,
  Skull,
  Trash2,
  UserPlus,
  X,
  type LucideIcon,
} from 'lucide-react';
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
import { coarseColor, coarseLabel, conditionColor, statusColor, statusLabel } from '@/lib/theme';
import { CONDITIONS, conditionDef } from '@/lib/conditions';
import { FreshnessDot } from '@/components/FreshnessDot';
import { BottomSheet } from '@/components/BottomSheet';
import { Dialog } from '@/components/Dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

const STATUSES: PlayerStatus[] = ['active', 'down', 'dying', 'dead', 'stable'];
const TIERS: MobTier[] = ['Troops', 'Elite', 'Adversary'];
const MOB_LABEL_MAX = 40;

const COARSE_ICON: Record<CoarseHp, LucideIcon> = {
  healthy: Heart,
  minor: ShieldAlert,
  gravely: HeartCrack,
  dead: Skull,
};

interface Freshness {
  secondsAgo: number;
  updatedAt: number | null;
  error: boolean;
}

/** Target of the shared condition picker sheet — a player card or a mob row. */
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

  const nameByIndex = useMemo(() => {
    const m = new Map<number, string>();
    for (const p of snapshot.players) m.set(p.index, p.name);
    return (i: number) => (i === 0 ? 'GM' : (m.get(i) ?? `Player ${i}`));
  }, [snapshot.players]);

  // Sheets / dialogs
  const [condTarget, setCondTarget] = useState<CondTarget | null>(null);
  const [tooltipId, setTooltipId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [confirm, setConfirm] = useState<'end' | 'round' | null>(null);

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
    onEnded();
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

  return (
    <div className="min-h-dvh bg-bg">
      {/* Header */}
      <header className="sticky top-0 z-20 border-b border-default bg-panel/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-3 md:px-6">
          <div className="flex flex-col">
            <span className="font-display text-lg font-bold tracking-[0.16em] text-gold">
              WRATH &amp; GLORY
            </span>
            <span className="text-xs uppercase tracking-[0.2em] text-muted">GM Console</span>
          </div>

          <div className="flex items-baseline gap-2">
            <span className="text-xs uppercase tracking-wide text-muted">Join code</span>
            <span className="font-display text-2xl font-bold tracking-[0.35em] text-gold">
              {code}
            </span>
          </div>

          <div className="flex items-center gap-4">
            <FreshnessDot
              secondsAgo={freshness.secondsAgo}
              updatedAt={freshness.updatedAt}
              error={freshness.error}
            />
            <Button variant="destructive" size="sm" onClick={() => setConfirm('end')}>
              <Power /> End session
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 py-5 md:px-6">
        {/* Counters + round */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <CounterCard
            label="Glory"
            value={session.glory}
            color="var(--color-gold)"
            onDelta={deltaGlory}
            onSet={setGlory}
          />
          <CounterCard
            label="Ruin"
            value={session.ruin}
            color="var(--color-ruin)"
            onDelta={deltaRuin}
            onSet={setRuin}
          >
            <PillToggle
              on={session.showRuin}
              onToggle={toggleShowRuin}
              onContent={
                <>
                  <Eye className="size-3.5" /> Shown
                </>
              }
              offContent={
                <>
                  <EyeOff className="size-3.5" /> Hidden
                </>
              }
            />
          </CounterCard>
          <RoundCard round={session.round} onNext={() => setConfirm('round')} />
        </div>

        {/* Management columns */}
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
          <div className="flex flex-col gap-5 xl:col-span-2">
            <PartyPanel players={admitted} actions={playerActions} />
            <MobPanel mobs={mobs} actions={mobActions} onAdd={() => setAddOpen(true)} />
          </div>
          <div className="flex flex-col gap-5">
            <LobbyPanel lobby={lobby} onAdmit={onAdmit} onIgnore={onIgnore} />
            <LogPanel log={log} nameByIndex={nameByIndex} onExport={exportLog} />
          </div>
        </div>
      </main>

      {/* ---- Condition picker (shared, player or mob) ---- */}
      <BottomSheet
        open={condTarget !== null}
        onClose={() => setCondTarget(null)}
        title="Add condition"
        footer={
          <Button className="w-full" onClick={() => setCondTarget(null)}>
            Done
          </Button>
        }
      >
        <div className="flex flex-col gap-1.5 pb-2">
          {CONDITIONS.map((def) => {
            const applied = targetEntity?.conditions.find((c) => c.id === def.id);
            const color = conditionColor(def.category);
            return (
              <button
                key={def.id}
                type="button"
                onClick={() => addConditionToTarget(def.id)}
                className="flex items-start gap-3 rounded-md border border-default bg-raised px-3 py-2 text-left transition-colors hover:border-emphasis"
              >
                <span className="mt-1 size-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex items-center gap-2">
                    <span className="font-medium text-text">{def.name}</span>
                    {applied && (
                      <span className="rounded-full border border-gold/60 px-1.5 text-[10px] text-gold">
                        {def.stacks && applied.rank ? `×${applied.rank}` : 'added'}
                      </span>
                    )}
                  </span>
                  <span className="line-clamp-2 text-xs text-muted">{def.summary}</span>
                </span>
                <Plus className="mt-0.5 size-4 shrink-0 text-muted" />
              </button>
            );
          })}
        </div>
      </BottomSheet>

      {/* ---- Condition tooltip ---- */}
      <BottomSheet
        open={tooltipId !== null}
        onClose={() => setTooltipId(null)}
        title={tooltipDef?.name ?? 'Condition'}
      >
        {tooltipDef ? (
          <div className="flex flex-col gap-3 pb-2">
            <span
              className="inline-flex w-fit items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs uppercase tracking-wide"
              style={{ borderColor: conditionColor(tooltipDef.category), color: conditionColor(tooltipDef.category) }}
            >
              {tooltipDef.category}
              {tooltipDef.stacks ? ' · stacks' : ''}
            </span>
            <p className="text-sm leading-relaxed text-text-2">{tooltipDef.summary}</p>
          </div>
        ) : (
          <p className="pb-2 text-sm text-muted">No details for &ldquo;{tooltipId}&rdquo;.</p>
        )}
      </BottomSheet>

      {/* ---- Add-mob dialog ---- */}
      <AddMobDialog open={addOpen} onClose={() => setAddOpen(false)} onSubmit={submitAddMobs} />

      {/* ---- Confirms ---- */}
      <ConfirmDialog
        open={confirm === 'round'}
        onClose={() => setConfirm(null)}
        title="Next round"
        body="Advance to the next round and reset every hero's (and mob's) Acted flag?"
        confirmLabel="Next round"
        onConfirm={doNextRound}
      />
      <ConfirmDialog
        open={confirm === 'end'}
        onClose={() => setConfirm(null)}
        title="End session"
        body="End this session for everyone? Players will drop off and the join code stops working."
        confirmLabel="End session"
        danger
        onConfirm={confirmEnd}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

function CounterCard({
  label,
  value,
  color,
  onDelta,
  onSet,
  children,
}: {
  label: string;
  value: number;
  color: string;
  onDelta: (d: number) => void;
  onSet: (v: number) => void;
  children?: ReactNode;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4">
        <div className="flex min-h-7 items-center justify-between gap-2">
          <span className="text-xs uppercase tracking-[0.16em] text-muted">{label}</span>
          {children}
        </div>
        <div className="flex items-center justify-between gap-3">
          <StepBtn label={`Decrease ${label}`} onClick={() => onDelta(-1)} disabled={value <= 0}>
            <Minus />
          </StepBtn>
          <div className="flex-1 text-center">
            <EditableNumber
              value={value}
              onCommit={onSet}
              ariaLabel={`Set ${label}`}
              color={color}
              className="font-display text-4xl font-bold leading-none"
            />
          </div>
          <StepBtn label={`Increase ${label}`} onClick={() => onDelta(1)}>
            <Plus />
          </StepBtn>
        </div>
      </CardContent>
    </Card>
  );
}

function RoundCard({ round, onNext }: { round: number; onNext: () => void }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4">
        <span className="min-h-7 text-xs uppercase tracking-[0.16em] text-muted">Round</span>
        <div className="flex items-center justify-between gap-3">
          <span className="font-display text-4xl font-bold leading-none tabular-nums text-gold">
            {round}
          </span>
          <Button onClick={onNext}>
            <ChevronsRight /> Next round
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** Click-to-set number: renders a button that swaps to an input on click. */
function EditableNumber({
  value,
  onCommit,
  ariaLabel,
  color,
  className,
}: {
  value: number;
  onCommit: (v: number) => void;
  ariaLabel: string;
  color?: string;
  className?: string;
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
        className={cn('tabular-nums transition-colors hover:opacity-80', className)}
        style={color ? { color } : undefined}
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
      className={cn(
        'w-24 rounded-md border border-emphasis bg-raised px-2 text-center tabular-nums outline-none',
        className,
      )}
      style={color ? { color } : undefined}
    />
  );
}

// ---------------------------------------------------------------------------
// Party
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

function PartyPanel({ players, actions }: { players: Player[]; actions: PlayerActions }) {
  return (
    <Card>
      <CardHeader className="p-4 pb-2">
        <CardTitle>
          Party <span className="text-muted">({players.length})</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2.5 p-4 pt-2">
        {players.length === 0 ? (
          <p className="text-sm text-muted">No heroes admitted yet.</p>
        ) : (
          players.map((p) => <PlayerRow key={p.id} p={p} actions={actions} />)
        )}
      </CardContent>
    </Card>
  );
}

function PlayerRow({ p, actions }: { p: Player; actions: PlayerActions }) {
  return (
    <div className="flex flex-col gap-2.5 rounded-md border border-default bg-raised p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="rounded bg-track px-1.5 py-0.5 font-display text-xs font-semibold tabular-nums text-gold">
            P{p.index}
          </span>
          <span className="truncate font-medium text-text">{p.name}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <StatusSelect value={p.status} onChange={(s) => actions.onStatus(p, s)} />
          <RowAction danger label={`Kick ${p.name}`} onClick={() => actions.onKick(p)}>
            <Trash2 className="size-3.5" />
          </RowAction>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-x-5 gap-y-2.5">
        <Metric label="Wounds">
          <Stepper
            label="Wounds"
            value={p.wounds}
            max={p.maxWounds}
            onDelta={(d) => actions.onWounds(p, d)}
            color="var(--color-wounds)"
          />
        </Metric>
        <Metric label="Shock">
          <Stepper
            label="Shock"
            value={p.shock}
            max={p.maxShock}
            onDelta={(d) => actions.onShock(p, d)}
            color="var(--color-shock)"
          />
        </Metric>
        <Metric label="Wrath">
          <Stepper
            label="Wrath"
            value={p.wrath}
            max={LIMITS.wrath.max}
            onDelta={(d) => actions.onWrath(p, d)}
            color="var(--color-wrath)"
          />
        </Metric>
        <Metric label="Turn">
          <PillToggle
            on={p.actedThisRound}
            onToggle={() => actions.onActed(p)}
            onContent={
              <>
                <Check className="size-3.5" /> Acted
              </>
            }
            offContent={<>Not acted</>}
          />
        </Metric>
      </div>

      <CondControls
        conditions={p.conditions}
        onAdd={() => actions.onOpenConditions(p)}
        onRemove={(id) => actions.onRemoveCondition(p, id)}
        onTap={actions.onTapCondition}
      />
    </div>
  );
}

function StatusSelect({ value, onChange }: { value: PlayerStatus; onChange: (s: PlayerStatus) => void }) {
  return (
    <select
      aria-label="Status"
      value={value}
      onChange={(e) => onChange(e.target.value as PlayerStatus)}
      className="rounded-md border border-strong bg-raised px-2 py-1 text-xs font-medium outline-none focus-visible:border-emphasis"
      style={{ color: statusColor(value) }}
    >
      {STATUSES.map((s) => (
        <option key={s} value={s} className="bg-panel text-text">
          {statusLabel(s)}
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

function MobPanel({ mobs, actions, onAdd }: { mobs: Mob[]; actions: MobActions; onAdd: () => void }) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between p-4 pb-2">
        <CardTitle>
          Enemies <span className="text-muted">({mobs.length})</span>
        </CardTitle>
        <Button size="sm" onClick={onAdd}>
          <Plus /> Add
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-2.5 p-4 pt-2">
        {mobs.length === 0 ? (
          <p className="text-sm text-muted">No mobs on the board.</p>
        ) : (
          mobs.map((m) => <MobRow key={m.id} m={m} actions={actions} />)
        )}
      </CardContent>
    </Card>
  );
}

function MobRow({ m, actions }: { m: Mob; actions: MobActions }) {
  const c = coarse(m.hp, m.maxHp);
  const Icon = COARSE_ICON[c];
  const color = coarseColor(c);

  return (
    <div className={cn('flex flex-col gap-2.5 rounded-md border bg-raised p-3', m.revealed ? 'border-default' : 'border-dashed border-strong')}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <InlineName name={m.label} onCommit={(v) => actions.onRename(m, v)} />
          {!m.revealed && (
            <span className="shrink-0 rounded-full border border-strong px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">
              Hidden
            </span>
          )}
        </div>
        <span className="shrink-0 text-[11px] uppercase tracking-wide text-faint">{m.tier}</span>
      </div>

      <div className="flex flex-wrap items-end gap-x-5 gap-y-2.5">
        <Metric label="HP">
          <div className="flex items-center gap-2">
            <span
              className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium"
              style={{ borderColor: color, color }}
            >
              <Icon className="size-3.5" aria-hidden />
              {coarseLabel(c)}
            </span>
            <Stepper label="HP" value={m.hp} max={m.maxHp} onDelta={(d) => actions.onHp(m, d)} color={color} />
          </div>
        </Metric>
        <Metric label="Turn">
          <PillToggle
            on={m.actedThisRound}
            onToggle={() => actions.onActed(m)}
            onContent={
              <>
                <Check className="size-3.5" /> Acted
              </>
            }
            offContent={<>Not acted</>}
          />
        </Metric>
        <Metric label="Visibility">
          <PillToggle
            on={m.revealed}
            onToggle={() => actions.onReveal(m)}
            onContent={
              <>
                <Eye className="size-3.5" /> Shown
              </>
            }
            offContent={
              <>
                <EyeOff className="size-3.5" /> Hidden
              </>
            }
          />
        </Metric>
      </div>

      <CondControls
        conditions={m.conditions}
        onAdd={() => actions.onOpenConditions(m)}
        onRemove={(id) => actions.onRemoveCondition(m, id)}
        onTap={actions.onTapCondition}
      />

      <div className="flex items-center gap-2">
        <RowAction label={`Duplicate ${m.label}`} onClick={() => actions.onDuplicate(m)}>
          <Copy className="size-3.5" /> Duplicate
        </RowAction>
        <RowAction label={`Kill ${m.label}`} onClick={() => actions.onKill(m)}>
          <Skull className="size-3.5" /> Kill
        </RowAction>
        <RowAction danger label={`Remove ${m.label}`} onClick={() => actions.onDelete(m)} className="ml-auto">
          <Trash2 className="size-3.5" /> Remove
        </RowAction>
      </div>
    </div>
  );
}

/** Inline rename: click the label to edit; Enter/blur commits, Esc cancels. */
function InlineName({ name, onCommit }: { name: string; onCommit: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  if (!editing) {
    return (
      <button
        type="button"
        title="Rename"
        onClick={() => {
          setDraft(name);
          setEditing(true);
        }}
        className="min-w-0 truncate text-left font-medium text-text transition-colors hover:text-gold"
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
      className="min-w-0 rounded-md border border-emphasis bg-raised px-2 py-0.5 font-medium text-text outline-none"
    />
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
    <Card>
      <CardHeader className="p-4 pb-2">
        <CardTitle>
          Lobby <span className="text-muted">({lobby.length})</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 p-4 pt-2">
        {lobby.length === 0 ? (
          <p className="text-sm text-muted">No one waiting to be admitted.</p>
        ) : (
          lobby.map((p) => (
            <div
              key={p.id}
              className="flex items-center justify-between gap-2 rounded-md border border-default bg-raised px-3 py-2"
            >
              <span className="truncate text-text">{p.name}</span>
              <div className="flex shrink-0 items-center gap-2">
                <RowAction label={`Admit ${p.name}`} onClick={() => onAdmit(p)}>
                  <UserPlus className="size-3.5" /> Admit
                </RowAction>
                <RowAction danger label={`Ignore ${p.name}`} onClick={() => onIgnore(p)}>
                  <X className="size-3.5" /> Ignore
                </RowAction>
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
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
    <Card>
      <CardHeader className="flex-row items-center justify-between p-4 pb-2">
        <CardTitle className="flex items-center gap-2">
          <ScrollText className="size-4 text-muted" /> Activity log
        </CardTitle>
        <Button variant="outline" size="sm" onClick={onExport} disabled={log.length === 0}>
          <Download /> Export
        </Button>
      </CardHeader>
      <CardContent className="p-4 pt-2">
        {log.length === 0 ? (
          <p className="text-sm text-muted">No activity yet.</p>
        ) : (
          <ul className="flex max-h-96 flex-col gap-1.5 overflow-y-auto pr-1">
            {log
              .map((e) => decodeLog(e))
              .map((v, i) => ({ v, key: i }))
              .reverse()
              .map(({ v, key }) => (
                <li
                  key={key}
                  className="flex items-baseline justify-between gap-3 rounded-md border border-default bg-raised px-3 py-2"
                >
                  <span className="text-sm text-text-2">{formatLog(v, nameByIndex)}</span>
                  <span className="shrink-0 text-[11px] tabular-nums text-faint">{fmtTime(v.ts)}</span>
                </li>
              ))}
          </ul>
        )}
      </CardContent>
    </Card>
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

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add mobs"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? 'Adding…' : count > 1 ? `Add ${count}` : 'Add'}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Name">
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={MOB_LABEL_MAX}
            placeholder={DEFAULTS.mob.label}
          />
        </Field>

        <Field label="Tier">
          <div className="grid grid-cols-3 gap-2">
            {TIERS.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTier(t)}
                className={cn(
                  'rounded-md border py-2 text-sm font-medium transition-colors',
                  tier === t
                    ? 'border-gold bg-gold/15 text-gold'
                    : 'border-strong bg-raised text-text-2 hover:border-emphasis hover:text-text',
                )}
              >
                {t}
              </button>
            ))}
          </div>
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Max HP">
            <div className="flex items-center gap-2">
              <StepBtn
                label="Decrease max HP"
                onClick={() => setMaxHp((v) => Math.max(LIMITS.mobMaxHp.min, v - 1))}
                disabled={maxHp <= LIMITS.mobMaxHp.min}
              >
                <Minus />
              </StepBtn>
              <Input
                type="number"
                inputMode="numeric"
                min={LIMITS.mobMaxHp.min}
                value={maxHp}
                onChange={(e) =>
                  setMaxHp(Math.max(LIMITS.mobMaxHp.min, Number.parseInt(e.target.value, 10) || LIMITS.mobMaxHp.min))
                }
                className="text-center tabular-nums"
              />
              <StepBtn label="Increase max HP" onClick={() => setMaxHp((v) => v + 1)}>
                <Plus />
              </StepBtn>
            </div>
          </Field>

          <Field label="How many">
            <div className="flex items-center gap-2">
              <StepBtn
                label="Fewer"
                onClick={() => setCount((v) => Math.max(LIMITS.addMobCount.min, v - 1))}
                disabled={count <= LIMITS.addMobCount.min}
              >
                <Minus />
              </StepBtn>
              <span className="min-w-10 text-center font-display text-xl font-bold tabular-nums text-text">
                {count}
              </span>
              <StepBtn
                label="More"
                onClick={() => setCount((v) => Math.min(LIMITS.addMobCount.max, v + 1))}
                disabled={count >= LIMITS.addMobCount.max}
              >
                <Plus />
              </StepBtn>
            </div>
          </Field>
        </div>

        <div className="flex items-center justify-between rounded-md border border-default bg-raised px-3 py-2.5">
          <span className="text-sm text-text-2">Starts hidden from players</span>
          <PillToggle
            on={startsHidden}
            onToggle={() => setStartsHidden((v) => !v)}
            onContent={
              <>
                <EyeOff className="size-3.5" /> Hidden
              </>
            }
            offContent={
              <>
                <Eye className="size-3.5" /> Shown
              </>
            }
          />
        </div>

        {error && <p className="text-sm text-wounds">{error}</p>}
      </div>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs uppercase tracking-wide text-muted">{label}</span>
      {children}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Confirm dialog
// ---------------------------------------------------------------------------

function ConfirmDialog({
  open,
  onClose,
  title,
  body,
  confirmLabel,
  danger,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
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
      title={title}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant={danger ? 'destructive' : 'default'} onClick={confirm} disabled={busy}>
            {busy ? 'Working…' : confirmLabel}
          </Button>
        </div>
      }
    >
      <p className="text-sm text-text-2">{body}</p>
      {error && <p className="mt-2 text-sm text-wounds">{error}</p>}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

function Metric({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wide text-muted">{label}</span>
      {children}
    </div>
  );
}

function Stepper({
  label,
  value,
  max,
  min = 0,
  color,
  onDelta,
}: {
  label: string;
  value: number;
  max?: number;
  min?: number;
  color?: string;
  onDelta: (d: number) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <StepBtn size="sm" label={`Decrease ${label}`} onClick={() => onDelta(-1)} disabled={value <= min}>
        <Minus />
      </StepBtn>
      <span
        className="min-w-[3.25rem] text-center font-display text-base font-bold tabular-nums"
        style={color ? { color } : undefined}
      >
        {value}
        {max !== undefined && <span className="text-faint">/{max}</span>}
      </span>
      <StepBtn
        size="sm"
        label={`Increase ${label}`}
        onClick={() => onDelta(1)}
        disabled={max !== undefined && value >= max}
      >
        <Plus />
      </StepBtn>
    </div>
  );
}

function StepBtn({
  children,
  onClick,
  disabled,
  label,
  size = 'md',
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  label: string;
  size?: 'sm' | 'md';
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'grid shrink-0 place-items-center rounded-md border border-strong bg-raised text-text transition-colors hover:enabled:border-emphasis hover:enabled:bg-track disabled:opacity-40',
        size === 'sm' ? 'size-7 [&_svg]:size-3.5' : 'size-9 [&_svg]:size-4',
      )}
    >
      {children}
    </button>
  );
}

function PillToggle({
  on,
  onToggle,
  onContent,
  offContent,
}: {
  on: boolean;
  onToggle: () => void;
  onContent: ReactNode;
  offContent: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
        on
          ? 'border-gold bg-gold/15 text-gold'
          : 'border-strong bg-raised text-muted hover:border-emphasis hover:text-text',
      )}
    >
      {on ? onContent : offContent}
    </button>
  );
}

function RowAction({
  children,
  onClick,
  label,
  danger,
  className,
}: {
  children: ReactNode;
  onClick: () => void;
  label: string;
  danger?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors',
        danger
          ? 'border-wounds/40 text-wounds hover:bg-wounds/10'
          : 'border-strong bg-raised text-text-2 hover:border-emphasis hover:text-text',
        className,
      )}
    >
      {children}
    </button>
  );
}

function CondControls({
  conditions,
  onAdd,
  onRemove,
  onTap,
}: {
  conditions: AppliedCondition[];
  onAdd: () => void;
  onRemove: (id: string) => void;
  onTap: (id: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {conditions.map((c, i) => (
        <CondChip key={c.id + i} applied={c} onTap={() => onTap(c.id)} onRemove={() => onRemove(c.id)} />
      ))}
      <button
        type="button"
        onClick={onAdd}
        className="inline-flex items-center gap-1 rounded-full border border-strong bg-raised px-2 py-0.5 text-xs text-text-2 transition-colors hover:border-emphasis hover:text-text"
      >
        <Plus className="size-3.5" /> Condition
      </button>
    </div>
  );
}

function CondChip({
  applied,
  onTap,
  onRemove,
}: {
  applied: AppliedCondition;
  onTap: () => void;
  onRemove: () => void;
}) {
  const def = conditionDef(applied.id);
  const name = def?.name ?? applied.id;
  const color = def ? conditionColor(def.category) : 'var(--color-muted)';
  const rank = applied.rank && applied.rank > 1 ? ` ${applied.rank}` : '';
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border bg-raised px-2 py-0.5 text-xs"
      style={{ borderColor: color, color }}
    >
      <button type="button" onClick={onTap} className="max-w-[9rem] truncate">
        {name}
        {rank}
      </button>
      <button
        type="button"
        aria-label={`Remove ${name}`}
        onClick={onRemove}
        className="-mr-0.5 grid size-4 place-items-center rounded-full hover:bg-white/10"
      >
        <X className="size-3" />
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
