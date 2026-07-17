import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import type { AppliedCondition, CoarseHp, MobPublicView, Player, PlayerSnapshot, PlayerStatus } from '@domain';
import { clampCurrent, clampWrath, decodeLog, formatLog, LIMITS, nextCounter } from '@domain';
import {
  ArrowDown,
  ArrowUp,
  Check,
  Download,
  Heart,
  HeartCrack,
  Minus,
  Plus,
  ScrollText,
  ShieldAlert,
  Skull,
  X,
  type LucideIcon,
} from 'lucide-react';
import { adjustGlory, updatePlayer, type PlayerPatch } from '@/lib/api';
import { clearIdentity, loadIdentity } from '@/lib/identity';
import { useSessionState } from '@/lib/useSessionState';
import { coarseColor, coarseLabel, conditionColor, statusColor, statusLabel } from '@/lib/theme';
import { CONDITIONS, conditionDef } from '@/lib/conditions';
import { FreshnessDot } from '@/components/FreshnessDot';
import { BottomSheet } from '@/components/BottomSheet';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface Freshness {
  secondsAgo: number;
  updatedAt: number | null;
  error: boolean;
}

export default function Play() {
  const navigate = useNavigate();
  const identity = useMemo(() => loadIdentity(), []);

  const args = identity?.role === 'player' ? { code: identity.code, token: identity.token } : null;
  const { snapshot, secondsAgo, updatedAt, error, loading, refresh } =
    useSessionState<PlayerSnapshot>(args);

  if (!identity || identity.role !== 'player') return <Navigate to="/" replace />;

  const leave = () => {
    clearIdentity();
    navigate('/', { replace: true });
  };

  if (!snapshot) {
    return (
      <div className="grid min-h-dvh place-items-center bg-bg-player px-6 text-center">
        <p className="text-muted">
          {loading ? 'Loading session…' : error ? 'Connection lost. Retrying…' : 'No session.'}
        </p>
      </div>
    );
  }

  return (
    <PlayerBoard
      snapshot={snapshot}
      code={identity.code}
      token={identity.token}
      freshness={{ secondsAgo, updatedAt, error: !!error }}
      onLeave={leave}
      refresh={refresh}
    />
  );
}

// ---------------------------------------------------------------------------
// Board — owns optimistic self-edit state and renders the whole screen.
// ---------------------------------------------------------------------------

interface BoardProps {
  snapshot: PlayerSnapshot;
  code: string;
  token: string;
  freshness: Freshness;
  onLeave: () => void;
  refresh: () => void;
}

function PlayerBoard({ snapshot, code, token, freshness, onLeave, refresh }: BoardProps) {
  const { session, players, mobs, log, youId } = snapshot;
  const serverYou = players.find((p) => p.id === youId) ?? null;

  // Optimistic overlays: `overrides` merges over the server "you"; `gloryOverride`
  // shadows the shared counter. `pending`/`gloryPending` count in-flight PATCHes so we
  // only adopt server truth once nothing is mid-flight (reconcile on the next poll).
  const [overrides, setOverrides] = useState<Partial<Player>>({});
  const [gloryOverride, setGloryOverride] = useState<number | null>(null);
  const pending = useRef(0);
  const gloryPending = useRef(0);
  // Serialize the network sends per target so absolute-value PATCHes land in tap order
  // (the optimistic UI still updates instantly; only the requests are ordered).
  const selfChain = useRef<Promise<void>>(Promise.resolve());
  const gloryChain = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    if (pending.current === 0) setOverrides((o) => (Object.keys(o).length ? {} : o));
    if (gloryPending.current === 0) setGloryOverride((g) => (g === null ? g : null));
  }, [snapshot]);

  const you = serverYou ? { ...serverYou, ...overrides } : null;
  const glory = gloryOverride ?? session.glory;

  // Sheets
  const [tooltipId, setTooltipId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);

  const nameByIndex = useMemo(() => {
    const m = new Map<number, string>();
    for (const p of players) m.set(p.index, p.name);
    return (i: number) => (i === 0 ? 'GM' : (m.get(i) ?? `Player ${i}`));
  }, [players]);

  // --- self-edit (optimistic) ----------------------------------------------
  function patchSelf(patch: PlayerPatch, optimistic: Partial<Player>) {
    setOverrides((o) => ({ ...o, ...optimistic }));
    pending.current += 1;
    selfChain.current = selfChain.current.then(async () => {
      try {
        await updatePlayer(code, token, youId, patch);
      } catch {
        setOverrides({}); // revert to server truth on error
      } finally {
        pending.current -= 1;
        if (pending.current === 0) refresh();
      }
    });
  }

  function pushGlory(delta: number) {
    setGloryOverride((g) => nextCounter(g ?? session.glory, delta));
    gloryPending.current += 1;
    gloryChain.current = gloryChain.current.then(async () => {
      try {
        const res = await adjustGlory(code, token, delta);
        setGloryOverride(res.glory);
      } catch {
        setGloryOverride(null); // revert
      } finally {
        gloryPending.current -= 1;
        if (gloryPending.current === 0) refresh();
      }
    });
  }

  const onWounds = (d: number) => {
    if (!you) return;
    const v = clampCurrent(you.wounds + d, you.maxWounds);
    if (v !== you.wounds) void patchSelf({ wounds: v }, { wounds: v });
  };
  const onShock = (d: number) => {
    if (!you) return;
    const v = clampCurrent(you.shock + d, you.maxShock);
    if (v !== you.shock) void patchSelf({ shock: v }, { shock: v });
  };
  const onWrath = (d: number) => {
    if (!you) return;
    const v = clampWrath(you.wrath + d);
    if (v !== you.wrath) void patchSelf({ wrath: v }, { wrath: v });
  };
  const onToggleActed = () => {
    if (!you) return;
    void patchSelf({ actedThisRound: !you.actedThisRound }, { actedThisRound: !you.actedThisRound });
  };
  const onToggleDown = () => {
    if (!you) return;
    const status: PlayerStatus = you.status === 'active' ? 'down' : 'active';
    void patchSelf({ status }, { status });
  };
  const onRemoveCondition = (id: string) => {
    if (!you) return;
    const conditions = you.conditions.filter((c) => c.id !== id);
    void patchSelf({ conditions }, { conditions });
  };
  const onAddCondition = (id: string) => {
    if (!you) return;
    const def = conditionDef(id);
    const existing = you.conditions.find((c) => c.id === id);
    let conditions: AppliedCondition[];
    if (existing) {
      if (!def?.stacks) return; // already present, doesn't stack
      conditions = you.conditions.map((c) =>
        c.id === id ? { ...c, rank: (c.rank ?? 1) + 1 } : c,
      );
    } else {
      conditions = [...you.conditions, def?.stacks ? { id, rank: 1 } : { id }];
    }
    void patchSelf({ conditions }, { conditions });
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

  const roster = players.map((p) => (you && p.id === youId ? you : p));
  const others = players.filter((p) => p.id !== youId);
  const tooltipDef = tooltipId ? conditionDef(tooltipId) : undefined;

  return (
    <div className="min-h-dvh bg-bg-player">
      {/* Sticky header: round + turn strip + acted toggle */}
      <header className="sticky top-0 z-30 border-b border-default bg-panel/95 backdrop-blur">
        <div className="mx-auto w-full max-w-[430px] px-4">
          <div className="flex items-center justify-between gap-3 py-2.5">
            <div className="flex items-baseline gap-2">
              <span className="text-xs uppercase tracking-wide text-muted">Round</span>
              <span className="font-display text-2xl font-bold tabular-nums text-gold">
                {session.round}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <FreshnessDot
                secondsAgo={freshness.secondsAgo}
                updatedAt={freshness.updatedAt}
                error={freshness.error}
              />
              <Button variant="ghost" size="sm" onClick={onLeave}>
                Leave
              </Button>
            </div>
          </div>

          <div className="flex gap-2 overflow-x-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {roster.map((p) => (
              <TurnChip key={p.id} player={p} isYou={p.id === youId} />
            ))}
          </div>

          <div className="pb-2.5">
            <ActedToggle acted={!!you?.actedThisRound} onToggle={onToggleActed} disabled={!you} />
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-[430px] flex-col gap-4 px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <ResourcesCard
          glory={glory}
          ruin={session.ruin}
          onPull={() => void pushGlory(-1)}
          onPush={() => void pushGlory(1)}
          onOpenLog={() => setLogOpen(true)}
        />

        {you ? (
          <YourCard
            you={you}
            onWounds={onWounds}
            onShock={onShock}
            onWrath={onWrath}
            onToggleDown={onToggleDown}
            onRemoveCondition={onRemoveCondition}
            onOpenPicker={() => setPickerOpen(true)}
            onOpenTooltip={setTooltipId}
          />
        ) : (
          <Card>
            <CardContent className="p-4">
              <p className="text-sm text-muted">Your character isn&apos;t in this session anymore.</p>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader className="p-4 pb-2">
            <CardTitle>
              Party <span className="text-muted">({others.length})</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 p-4 pt-0">
            {others.length === 0 && <p className="text-sm text-muted">No other players yet.</p>}
            {others.map((p) => (
              <PartyRow key={p.id} player={p} onTapCondition={setTooltipId} />
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="p-4 pb-2">
            <CardTitle>
              Enemies <span className="text-muted">({mobs.length})</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 p-4 pt-0">
            {mobs.length === 0 && <p className="text-sm text-muted">No enemies revealed.</p>}
            {mobs.map((m) => (
              <EnemyRow key={m.id} mob={m} onTapCondition={setTooltipId} />
            ))}
          </CardContent>
        </Card>
      </main>

      {/* --- Bottom sheets ---------------------------------------------------- */}
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

      <BottomSheet
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title="Add condition"
        footer={
          <Button className="w-full" onClick={() => setPickerOpen(false)}>
            Done
          </Button>
        }
      >
        <div className="flex flex-col gap-1.5 pb-2">
          {CONDITIONS.map((def) => {
            const applied = you?.conditions.find((c) => c.id === def.id);
            const color = conditionColor(def.category);
            return (
              <button
                key={def.id}
                type="button"
                onClick={() => onAddCondition(def.id)}
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

      <BottomSheet
        open={logOpen}
        onClose={() => setLogOpen(false)}
        title="Activity log"
        footer={
          <Button variant="outline" className="w-full" onClick={exportLog} disabled={log.length === 0}>
            <Download /> Export JSON
          </Button>
        }
      >
        {log.length === 0 ? (
          <p className="pb-2 text-sm text-muted">No activity yet.</p>
        ) : (
          <ul className="flex flex-col gap-1.5 pb-2">
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
      </BottomSheet>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Presentational pieces
// ---------------------------------------------------------------------------

function TurnChip({ player, isYou }: { player: Player; isYou: boolean }) {
  const acted = player.actedThisRound;
  return (
    <div
      className={cn(
        'flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm',
        isYou
          ? 'border-gold bg-gold/10 text-gold'
          : acted
            ? 'border-default bg-raised text-muted'
            : 'border-strong bg-raised text-text',
      )}
    >
      {acted ? (
        <Check className="size-3.5" />
      ) : (
        <span className="size-1.5 rounded-full bg-current opacity-70" aria-hidden />
      )}
      <span className="max-w-[7rem] truncate">
        {player.name}
        {isYou && ' · You'}
      </span>
    </div>
  );
}

function ActedToggle({
  acted,
  onToggle,
  disabled,
}: {
  acted: boolean;
  onToggle: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      className={cn(
        'flex w-full items-center justify-center gap-2 rounded-lg border py-2.5 font-display text-sm font-semibold uppercase tracking-[0.15em] transition-colors disabled:opacity-50',
        acted
          ? 'border-gold bg-gold text-on-gold'
          : 'border-strong bg-raised text-text hover:border-emphasis',
      )}
    >
      {acted ? (
        <>
          <Check className="size-4" /> Acted
        </>
      ) : (
        "I've acted"
      )}
    </button>
  );
}

function ResourcesCard({
  glory,
  ruin,
  onPull,
  onPush,
  onOpenLog,
}: {
  glory: number;
  ruin: number | null;
  onPull: () => void;
  onPush: () => void;
  onOpenLog: () => void;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between">
          <div className="flex flex-col">
            <span className="text-xs uppercase tracking-wide text-muted">Glory</span>
            <span className="font-display text-4xl font-bold tabular-nums text-gold">{glory}</span>
          </div>
          <div className="flex items-start gap-3">
            {ruin !== null && (
              <div className="flex flex-col items-end">
                <span className="text-xs uppercase tracking-wide text-muted">Ruin</span>
                <span className="font-display text-2xl font-bold tabular-nums text-ruin">{ruin}</span>
              </div>
            )}
            <button
              type="button"
              onClick={onOpenLog}
              className="inline-flex items-center gap-1.5 rounded-md border border-strong bg-raised px-2.5 py-1.5 text-xs text-text-2 transition-colors hover:border-emphasis hover:text-text"
            >
              <ScrollText className="size-4" /> Log
            </button>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Button variant="secondary" onClick={onPull} disabled={glory <= 0}>
            <Minus /> Pull 1
          </Button>
          <Button onClick={onPush}>
            <Plus /> Push 1
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

interface YourCardProps {
  you: Player;
  onWounds: (d: number) => void;
  onShock: (d: number) => void;
  onWrath: (d: number) => void;
  onToggleDown: () => void;
  onRemoveCondition: (id: string) => void;
  onOpenPicker: () => void;
  onOpenTooltip: (id: string) => void;
}

function YourCard({
  you,
  onWounds,
  onShock,
  onWrath,
  onToggleDown,
  onRemoveCondition,
  onOpenPicker,
  onOpenTooltip,
}: YourCardProps) {
  const down = you.status !== 'active';
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between p-4">
        <CardTitle className="truncate">{you.name}</CardTitle>
        <span
          className="flex shrink-0 items-center gap-1.5 text-xs font-medium"
          style={{ color: statusColor(you.status) }}
        >
          <span className="size-2 rounded-full" style={{ backgroundColor: statusColor(you.status) }} />
          {statusLabel(you.status)}
        </span>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 p-4 pt-0">
        <BarStepper
          label="Wounds"
          value={you.wounds}
          max={you.maxWounds}
          color="var(--color-wounds)"
          onDelta={onWounds}
        />
        <BarStepper
          label="Shock"
          value={you.shock}
          max={you.maxShock}
          color="var(--color-shock)"
          onDelta={onShock}
        />

        <div className="flex items-center justify-between rounded-md border border-default bg-raised px-3 py-2">
          <span className="text-xs uppercase tracking-wide text-muted">Wrath</span>
          <div className="flex items-center gap-3">
            <StepBtn label="Decrease Wrath" onClick={() => onWrath(-1)} disabled={you.wrath <= LIMITS.wrath.min}>
              <Minus />
            </StepBtn>
            <span className="min-w-6 text-center font-display text-xl font-bold tabular-nums text-wrath">
              {you.wrath}
            </span>
            <StepBtn label="Increase Wrath" onClick={() => onWrath(1)} disabled={you.wrath >= LIMITS.wrath.max}>
              <Plus />
            </StepBtn>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-xs uppercase tracking-wide text-muted">Conditions</span>
            <button
              type="button"
              onClick={onOpenPicker}
              className="inline-flex items-center gap-1 rounded-md border border-strong bg-raised px-2 py-1 text-xs text-text-2 transition-colors hover:border-emphasis hover:text-text"
            >
              <Plus className="size-3.5" /> Condition
            </button>
          </div>
          {you.conditions.length === 0 ? (
            <p className="text-xs text-faint">No active conditions.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {you.conditions.map((c, i) => (
                <ConditionChip
                  key={c.id + i}
                  applied={c}
                  onTap={() => onOpenTooltip(c.id)}
                  onRemove={() => onRemoveCondition(c.id)}
                />
              ))}
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={onToggleDown}
          className={cn(
            'flex w-full items-center justify-center gap-2 rounded-md border py-2.5 text-sm font-medium transition-colors',
            down
              ? 'border-status-active/50 text-status-active hover:bg-status-active/10'
              : 'border-wounds/50 text-wounds hover:bg-wounds/10',
          )}
        >
          {down ? (
            <>
              <ArrowUp className="size-4" /> Stand up
            </>
          ) : (
            <>
              <ArrowDown className="size-4" /> Go down
            </>
          )}
        </button>
      </CardContent>
    </Card>
  );
}

function BarStepper({
  label,
  value,
  max,
  color,
  onDelta,
}: {
  label: string;
  value: number;
  max: number;
  color: string;
  onDelta: (d: number) => void;
}) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-wide text-muted">{label}</span>
        <span className="font-display text-sm font-semibold tabular-nums" style={{ color }}>
          {value}
          <span className="text-faint">/{max}</span>
        </span>
      </div>
      <div className="flex items-center gap-2">
        <StepBtn label={`Decrease ${label}`} onClick={() => onDelta(-1)} disabled={value <= 0}>
          <Minus />
        </StepBtn>
        <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-track">
          <div
            className="h-full rounded-full transition-[width] duration-300"
            style={{ width: `${pct}%`, backgroundColor: color }}
          />
        </div>
        <StepBtn label={`Increase ${label}`} onClick={() => onDelta(1)} disabled={value >= max}>
          <Plus />
        </StepBtn>
      </div>
    </div>
  );
}

function StepBtn({
  children,
  onClick,
  disabled,
  label,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="grid size-9 shrink-0 place-items-center rounded-md border border-strong bg-raised text-text transition-colors hover:enabled:border-emphasis hover:enabled:bg-track disabled:opacity-40 [&_svg]:size-4"
    >
      {children}
    </button>
  );
}

function ConditionChip({
  applied,
  onTap,
  onRemove,
}: {
  applied: AppliedCondition;
  onTap: () => void;
  onRemove?: () => void;
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
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${name}`}
          onClick={onRemove}
          className="-mr-0.5 grid size-4 place-items-center rounded-full hover:bg-white/10"
        >
          <X className="size-3" />
        </button>
      )}
    </span>
  );
}

function PartyRow({ player, onTapCondition }: { player: Player; onTapCondition: (id: string) => void }) {
  return (
    <div className="rounded-md border border-default bg-raised px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-text">{player.name}</span>
        <span
          className="flex shrink-0 items-center gap-1.5 text-xs font-medium"
          style={{ color: statusColor(player.status) }}
        >
          <span className="size-2 rounded-full" style={{ backgroundColor: statusColor(player.status) }} />
          {statusLabel(player.status)}
        </span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
        <MiniBar label="W" value={player.wounds} max={player.maxWounds} color="var(--color-wounds)" />
        <MiniBar label="S" value={player.shock} max={player.maxShock} color="var(--color-shock)" />
      </div>
      {player.conditions.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {player.conditions.map((c, i) => (
            <ConditionChip key={c.id + i} applied={c} onTap={() => onTapCondition(c.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function MiniBar({
  label,
  value,
  max,
  color,
}: {
  label: string;
  value: number;
  max: number;
  color: string;
}) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-3 shrink-0 text-[10px] uppercase text-faint">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-track">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
      <span className="shrink-0 text-[10px] tabular-nums text-muted">
        {value}/{max}
      </span>
    </div>
  );
}

const COARSE_ICON: Record<CoarseHp, LucideIcon> = {
  healthy: Heart,
  minor: ShieldAlert,
  gravely: HeartCrack,
  dead: Skull,
};

function EnemyRow({ mob, onTapCondition }: { mob: MobPublicView; onTapCondition: (id: string) => void }) {
  const Icon = COARSE_ICON[mob.coarse];
  const color = coarseColor(mob.coarse);
  return (
    <div className="flex items-center gap-3 rounded-md border border-default bg-raised px-3 py-2">
      <Icon className="size-5 shrink-0" style={{ color }} aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-text">{mob.label}</span>
        <span className="text-[11px] uppercase tracking-wide text-faint">{mob.tier}</span>
      </div>
      <div className="flex flex-col items-end gap-1">
        <span className="text-xs font-medium" style={{ color }}>
          {coarseLabel(mob.coarse)}
        </span>
        {mob.conditions.length > 0 && (
          <div className="flex flex-wrap justify-end gap-1">
            {mob.conditions.map((c, i) => (
              <ConditionChip key={c.id + i} applied={c} onTap={() => onTapCondition(c.id)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function fmtTime(tsSeconds: number): string {
  return new Date(tsSeconds * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
