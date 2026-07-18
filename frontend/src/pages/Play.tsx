import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import type {
  AppliedCondition,
  CoarseHp,
  ConditionCategory,
  MobPublicView,
  Player,
  PlayerSnapshot,
  PlayerStatus,
} from '@domain';
import { clampCurrent, clampWrath, decodeLog, formatLog, LIMITS, nextCounter } from '@domain';
import { Check, Download, Eye, X } from 'lucide-react';
import { adjustGlory, updatePlayer, type PlayerPatch } from '@/lib/api';
import { clearIdentity, loadIdentity } from '@/lib/identity';
import { useSessionState } from '@/lib/useSessionState';
import { coarseColor, coarseLabel, statusColor, statusLabel } from '@/lib/theme';
import { CONDITIONS, conditionDef } from '@/lib/conditions';
import { FreshnessDot } from '@/components/FreshnessDot';
import { BottomSheet } from '@/components/BottomSheet';
import { ReconnectingBanner, Takeover } from '@/components/Takeover';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface Freshness {
  secondsAgo: number;
  updatedAt: number | null;
  error: boolean;
}

// Condition-chip theming for the player screen (prototype): damage = red, affliction =
// violet, everything else (impairment) = gold/neutral. This is a local remap of the
// shared category→token mapping (theme.ts keeps impairment blue for the GM screen).
const CONDITION_CHIP_COLOR: Record<ConditionCategory, string> = {
  damage: 'var(--color-red)',
  affliction: 'var(--color-violet)',
  impairment: 'var(--color-gold)',
};
const chipColor = (c: ConditionCategory): string => CONDITION_CHIP_COLOR[c];

/** Build an alpha'd colour from a token/var — used for subtle tints on var-based colours. */
const alpha = (color: string, pct: number): string =>
  `color-mix(in srgb, ${color} ${pct}%, transparent)`;

export default function Play() {
  const navigate = useNavigate();
  const identity = useMemo(() => loadIdentity(), []);

  const args = identity?.role === 'player' ? { code: identity.code, token: identity.token } : null;
  const { snapshot, secondsAgo, updatedAt, error, status, loading, refresh } =
    useSessionState<PlayerSnapshot>(args);

  if (!identity || identity.role !== 'player') return <Navigate to="/" replace />;

  const leave = () => {
    clearIdentity();
    navigate('/', { replace: true });
  };

  // Lifecycle takeovers (SPEC §7.10). Terminal snapshot states win over transient ones:
  // a session that has reflected 'ended' stays ended even after its item later 404s, since
  // the last snapshot is retained across a failing poll.
  const you = snapshot ? (snapshot.players.find((p) => p.id === snapshot.youId) ?? null) : null;
  if (you?.presence === 'removed') return <Takeover variant="removed" onBack={leave} />;
  if (snapshot?.session.state === 'ended') return <Takeover variant="ended" onBack={leave} />;
  if (status === 'gone' || status === 'unauthorized')
    return <Takeover variant="expired" onBack={leave} />;

  if (!snapshot) {
    return (
      <div className="grid min-h-dvh place-items-center bg-bg px-6 text-center">
        <p className="text-muted">{loading ? 'Loading session…' : 'Connection lost. Retrying…'}</p>
      </div>
    );
  }

  return (
    <>
      {status === 'offline' && <ReconnectingBanner />}
      <PlayerBoard
        snapshot={snapshot}
        code={identity.code}
        token={identity.token}
        freshness={{ secondsAgo, updatedAt, error: !!error }}
        onLeave={leave}
        refresh={refresh}
      />
    </>
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
  const actedCount = roster.filter((p) => p.actedThisRound).length;
  const others = players.filter((p) => p.id !== youId);
  const tooltipDef = tooltipId ? conditionDef(tooltipId) : undefined;

  return (
    <div className="min-h-dvh bg-bg-player">
      {/* Centered 430px column: 40K dark bg + hairline side borders + ambient gold glow. */}
      <div className="relative mx-auto min-h-dvh w-full max-w-[430px] border-x border-[#241d12] bg-bg">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 z-0 h-[340px]"
          style={{
            background:
              'radial-gradient(120% 60% at 50% -5%, rgba(240,180,41,0.06), transparent 42%)',
          }}
        />

        {/* Sticky header: title + join code + freshness, round strip, turn chips, acted. */}
        <header
          className="sticky top-0 z-30 border-b border-default shadow-[0_6px_20px_-8px_rgba(0,0,0,0.65)]"
          style={{ background: 'linear-gradient(180deg,#151009,#0d0b08 88%)' }}
        >
          <div className="px-4">
            <div className="flex items-center justify-between gap-2 pt-2.5">
              <span className="font-display text-[15px] font-bold tracking-[1.5px] text-text-2">
                WRATH <span className="text-gold">&amp;</span> GLORY
              </span>
              <div className="flex items-center gap-2">
                <span className="rounded-[3px] border border-default px-[7px] py-[4px] font-display text-[11px] font-bold tracking-[1px] text-gold">
                  {code}
                </span>
                <FreshnessDot
                  secondsAgo={freshness.secondsAgo}
                  updatedAt={freshness.updatedAt}
                  error={freshness.error}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-[11px]"
                  onClick={onLeave}
                >
                  Leave
                </Button>
              </div>
            </div>

            <div className="flex items-baseline justify-between gap-3 pt-2">
              <span className="font-display text-[17px] font-bold tracking-[0.5px] text-text-2">
                ROUND <span className="text-gold">{session.round}</span>
              </span>
              <span className="text-[13px] italic text-muted">
                {actedCount} of {roster.length} acted
              </span>
            </div>

            <div className="mt-2 flex gap-2 overflow-x-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {roster.map((p) => (
                <TurnChip key={p.id} player={p} isYou={p.id === youId} />
              ))}
            </div>

            <div className="pb-2.5">
              <ActedToggle acted={!!you?.actedThisRound} onToggle={onToggleActed} disabled={!you} />
            </div>
          </div>
        </header>

        <main className="relative z-10 flex flex-col gap-5 px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4">
          {/* SHARED RESOURCES ------------------------------------------------ */}
          <section>
            <SectionHeader
              label="SHARED RESOURCES"
              action={
                <button
                  type="button"
                  onClick={() => setLogOpen(true)}
                  className="inline-flex items-center gap-1.5 rounded-[4px] border border-default px-2 py-1 font-display text-[10px] tracking-[1.5px] text-muted transition-colors hover:border-emphasis hover:text-text"
                >
                  <span aria-hidden>☰</span> LOG
                </button>
              }
            />
            <SharedResources
              glory={glory}
              ruin={session.ruin}
              onPull={() => void pushGlory(-1)}
              onPush={() => void pushGlory(1)}
            />
          </section>

          {/* YOUR CHARACTER -------------------------------------------------- */}
          <section>
            <SectionHeader label="YOUR CHARACTER" />
            {you ? (
              <>
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
                <p className="mt-2.5 text-center text-[11px] italic text-faint">
                  You control only your own card. Tap a condition for its rules.
                </p>
              </>
            ) : (
              <div className="rounded-[6px] border border-default bg-panel p-4">
                <p className="text-sm text-muted">
                  Your character isn&apos;t in this session anymore.
                </p>
              </div>
            )}
          </section>

          {/* THE PARTY ------------------------------------------------------- */}
          <section>
            <SectionHeader label="THE PARTY" />
            <div className="flex flex-col gap-2">
              {others.length === 0 && (
                <p className="text-[13px] italic text-faint">No other players yet.</p>
              )}
              {others.map((p) => (
                <PartyRow key={p.id} player={p} onTapCondition={setTooltipId} />
              ))}
            </div>
          </section>

          {/* ENEMIES --------------------------------------------------------- */}
          <section>
            <SectionHeader label="ENEMIES" />
            <div className="flex flex-col gap-2">
              {mobs.length === 0 && (
                <p className="text-[13px] italic text-faint">No enemies revealed.</p>
              )}
              {mobs.map((m) => (
                <EnemyRow key={m.id} mob={m} onTapCondition={setTooltipId} />
              ))}
            </div>
          </section>
        </main>

        {/* --- Bottom sheets -------------------------------------------------- */}
        <BottomSheet
          open={tooltipId !== null}
          onClose={() => setTooltipId(null)}
          title={
            tooltipDef ? (
              <span style={{ color: chipColor(tooltipDef.category) }}>{tooltipDef.name}</span>
            ) : (
              'Condition'
            )
          }
        >
          {tooltipDef ? (
            <div className="flex flex-col gap-3 pb-2">
              {tooltipDef.stacks && (
                <span
                  className="w-fit rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[1px]"
                  style={{
                    borderColor: chipColor(tooltipDef.category),
                    color: chipColor(tooltipDef.category),
                  }}
                >
                  Stacks
                </span>
              )}
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
          <div className="grid grid-cols-2 gap-2 pb-2">
            {CONDITIONS.map((def) => {
              const applied = you?.conditions.find((c) => c.id === def.id);
              const color = chipColor(def.category);
              const sub = applied
                ? def.stacks && applied.rank
                  ? `Applied ×${applied.rank}`
                  : 'Applied'
                : def.stacks
                  ? 'Stackable'
                  : 'Single';
              return (
                <button
                  key={def.id}
                  type="button"
                  onClick={() => onAddCondition(def.id)}
                  className="flex flex-col gap-1 rounded-[6px] border bg-raised px-3 py-2.5 text-left transition-colors hover:border-emphasis"
                  style={{ borderColor: applied ? color : 'var(--color-default)' }}
                >
                  <span className="flex items-center gap-1.5">
                    <span
                      className="size-2 shrink-0 rounded-full"
                      style={{ backgroundColor: color }}
                    />
                    <span className="min-w-0 truncate font-display text-[13px] font-semibold text-text">
                      {def.name}
                    </span>
                  </span>
                  <span className="text-[11px] text-muted">{sub}</span>
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
            <Button
              variant="outline"
              className="w-full"
              onClick={exportLog}
              disabled={log.length === 0}
            >
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
                    className="flex items-center gap-2.5 rounded-[6px] border border-default bg-raised px-3 py-2"
                  >
                    <span
                      className="size-2 shrink-0 rounded-full"
                      style={{
                        backgroundColor:
                          v.type === 'G' ? 'var(--color-gold)' : 'var(--color-violet)',
                      }}
                    />
                    <span className="flex-1 text-[13px] text-text-2">
                      {formatLog(v, nameByIndex)}
                    </span>
                    <span className="shrink-0 text-[11px] italic tabular-nums text-faint">
                      {fmtTime(v.ts)}
                    </span>
                  </li>
                ))}
            </ul>
          )}
        </BottomSheet>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Presentational pieces
// ---------------------------------------------------------------------------

function SectionHeader({ label, action }: { label: string; action?: ReactNode }) {
  return (
    <div className="mb-2.5 flex items-center gap-2">
      <span aria-hidden className="text-[11px] leading-none text-gold">
        ◆
      </span>
      <span className="font-display text-[10px] font-semibold tracking-[3px] text-muted">
        {label}
      </span>
      {action && <div className="ml-auto">{action}</div>}
    </div>
  );
}

function PIndexChip({ index }: { index: number }) {
  return (
    <span className="shrink-0 rounded-[3px] border border-default px-1.5 py-0.5 font-display text-[10px] font-semibold tabular-nums text-muted">
      P{index}
    </span>
  );
}

function TurnChip({ player, isYou }: { player: Player; isYou: boolean }) {
  if (isYou) {
    return (
      <div
        className="flex shrink-0 items-center gap-1.5 rounded-full border-[1.5px] border-gold px-3 py-[7px] font-display text-[13px] text-gold"
        style={{ backgroundColor: 'rgba(240,180,41,0.12)' }}
      >
        <span className="max-w-[8rem] truncate">{player.name} · You</span>
      </div>
    );
  }
  if (player.actedThisRound) {
    return (
      <div
        className="flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-[7px] text-[13px]"
        style={{
          backgroundColor: 'rgba(62,207,106,0.12)',
          borderColor: 'rgba(62,207,106,0.4)',
          color: '#8fe0a6',
        }}
      >
        <Check className="size-3.5" style={{ color: '#3ecf6a' }} />
        <span className="max-w-[8rem] truncate">{player.name}</span>
      </div>
    );
  }
  return (
    <div className="flex shrink-0 items-center gap-1.5 rounded-full border border-default bg-transparent px-3 py-[7px] text-[13px] text-muted">
      <span className="size-[7px] rounded-full bg-faint" aria-hidden />
      <span className="max-w-[8rem] truncate">{player.name}</span>
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
        'flex w-full items-center justify-center gap-2 rounded-[6px] py-3 font-display font-bold uppercase transition-colors disabled:opacity-50',
        acted
          ? 'border text-[12px] tracking-[1.5px]'
          : 'bg-gold text-[13px] tracking-[2px] text-on-gold hover:bg-gold-hi',
      )}
      style={
        acted
          ? {
              backgroundColor: 'rgba(62,207,106,0.1)',
              borderColor: 'rgba(62,207,106,0.4)',
              color: '#3ecf6a',
            }
          : { boxShadow: '0 0 20px rgba(240,180,41,0.35)' }
      }
    >
      {acted ? (
        <>
          <Check className="size-4" /> YOU&apos;VE ACTED · TAP TO UNDO
        </>
      ) : (
        <>I&apos;VE ACTED</>
      )}
    </button>
  );
}

function SharedResources({
  glory,
  ruin,
  onPull,
  onPush,
}: {
  glory: number;
  ruin: number | null;
  onPull: () => void;
  onPush: () => void;
}) {
  return (
    <>
      <div className={ruin !== null ? 'grid grid-cols-[1.4fr_1fr] gap-2.5' : 'grid'}>
        <div className="rounded-[6px] border border-default bg-panel px-[15px] py-[13px]">
          <div className="font-display text-[10px] font-semibold tracking-[2px] text-gold">
            GLORY
          </div>
          <div
            className="font-display text-[50px] font-bold leading-none tabular-nums text-gold"
            style={{ textShadow: '0 0 22px rgba(240,180,41,0.45)' }}
          >
            {glory}
          </div>
          <div className="mt-1.5 text-[11px] italic text-muted">party pool · always seen</div>
        </div>
        {ruin !== null && (
          <div className="rounded-[6px] border border-default bg-panel px-[15px] py-[13px]">
            <div className="flex items-center gap-1 font-display text-[10px] font-semibold tracking-[2px] text-ruin">
              <Eye className="size-3" /> RUIN
            </div>
            <div
              className="font-display text-[50px] font-bold leading-none tabular-nums text-ruin"
              style={{ textShadow: '0 0 22px rgba(169,139,255,0.4)' }}
            >
              {ruin}
            </div>
            <div className="mt-1.5 text-[11px] italic text-muted">GM pool · view only</div>
          </div>
        )}
      </div>

      <div className="mt-2.5 flex gap-2.5">
        <button
          type="button"
          onClick={onPull}
          disabled={glory <= 0}
          className="flex-1 rounded-[6px] border border-emphasis py-[15px] font-display text-[12px] font-bold tracking-[1px] text-text transition-colors hover:enabled:bg-raised disabled:opacity-40"
        >
          PULL −1
        </button>
        <button
          type="button"
          onClick={onPush}
          className="flex-[1.3] rounded-[6px] bg-gold py-[15px] font-display text-[12px] font-bold tracking-[1px] text-on-gold transition-colors hover:bg-gold-hi"
          style={{ boxShadow: '0 0 18px rgba(240,180,41,0.25)' }}
        >
          PUSH +1
        </button>
      </div>

      <p className="mt-2.5 text-center text-[11px] italic text-faint">
        Anyone can push or pull Glory — every change is logged with your name.
      </p>
    </>
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
    <div
      className="rounded-[6px] border bg-panel p-[15px]"
      style={{
        borderColor: down ? '#6a4a2a' : 'var(--color-emphasis)',
        boxShadow: '0 0 0 1px rgba(240,180,41,0.08)',
      }}
    >
      {/* gold top-accent line, bled to the card edges */}
      <div
        aria-hidden
        style={{
          height: 2,
          margin: '-15px -15px 14px',
          background: 'linear-gradient(90deg,transparent,#f0b429,transparent)',
        }}
      />

      <div className="flex items-center gap-2">
        <PIndexChip index={you.index} />
        <span className="min-w-0 flex-1 truncate font-display text-[18px] font-semibold text-text">
          {you.name}
        </span>
        <span className="shrink-0 rounded-[3px] border border-gold/50 bg-gold/10 px-1.5 py-0.5 font-display text-[10px] font-semibold tracking-[1px] text-gold">
          YOU
        </span>
        <span
          className="shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-semibold"
          style={{
            backgroundColor: 'rgba(0,0,0,0.25)',
            borderColor: alpha(statusColor(you.status), 40),
            color: statusColor(you.status),
          }}
        >
          {statusLabel(you.status)}
        </span>
      </div>

      <div className="mt-4 flex flex-col gap-3.5">
        <StatBar
          label="WOUNDS"
          value={you.wounds}
          max={you.maxWounds}
          color="var(--color-wounds)"
          onDelta={onWounds}
        />
        <StatBar
          label="SHOCK"
          value={you.shock}
          max={you.maxShock}
          color="var(--color-shock)"
          onDelta={onShock}
        />
        <div className="flex items-center justify-between gap-3">
          <span className="font-display text-[10px] font-semibold tracking-[2px] text-muted">
            WRATH
          </span>
          <StepperGroup
            label="Wrath"
            value={you.wrath}
            valueColor="var(--color-wrath)"
            onDec={() => onWrath(-1)}
            onInc={() => onWrath(1)}
            decDisabled={you.wrath <= LIMITS.wrath.min}
            incDisabled={you.wrath >= LIMITS.wrath.max}
          />
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-1.5">
        {you.conditions.map((c, i) => (
          <ConditionChip
            key={c.id + i}
            applied={c}
            onTap={() => onOpenTooltip(c.id)}
            onRemove={() => onRemoveCondition(c.id)}
          />
        ))}
        <button
          type="button"
          onClick={onOpenPicker}
          className="rounded-full border border-dashed border-strong px-2.5 py-[3px] text-[11px] tracking-[0.5px] text-muted transition-colors hover:border-emphasis hover:text-text"
        >
          + CONDITION
        </button>
      </div>

      <button
        type="button"
        onClick={onToggleDown}
        className={cn(
          'mt-4 flex w-full items-center justify-center gap-2 rounded-[6px] py-3 font-display text-[12px] font-bold tracking-[1px] transition-colors',
          down ? 'text-on-gold' : 'border border-strong text-text hover:bg-raised',
        )}
        style={down ? { backgroundColor: 'var(--color-status-down)' } : undefined}
      >
        {down ? '▲ STAND BACK UP' : '▼ GO DOWN'}
      </button>
    </div>
  );
}

function StatBar({
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
    <div>
      <div className="flex items-center justify-between gap-3">
        <span className="font-display text-[10px] font-semibold tracking-[2px] text-muted">
          {label}
        </span>
        <StepperGroup
          label={label}
          value={value}
          onDec={() => onDelta(-1)}
          onInc={() => onDelta(1)}
          decDisabled={value <= 0}
          incDisabled={value >= max}
        />
      </div>
      <div className="mt-2 h-[11px] overflow-hidden rounded-[3px] border border-default bg-track">
        <div
          className="h-full transition-[width] duration-300"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
    </div>
  );
}

function StepperGroup({
  value,
  valueColor,
  onDec,
  onInc,
  decDisabled,
  incDisabled,
  label,
}: {
  value: number;
  valueColor?: string;
  onDec: () => void;
  onInc: () => void;
  decDisabled?: boolean;
  incDisabled?: boolean;
  label: string;
}) {
  return (
    <div className="inline-flex items-stretch overflow-hidden rounded-[5px] border border-strong">
      <button
        type="button"
        aria-label={`Decrease ${label}`}
        onClick={onDec}
        disabled={decDisabled}
        className="grid w-9 place-items-center font-display text-lg leading-none text-text transition-colors hover:enabled:bg-track disabled:opacity-40"
      >
        −
      </button>
      <span
        className="grid min-w-10 place-items-center border-x border-strong px-1 font-display text-lg font-bold tabular-nums text-text"
        style={valueColor ? { color: valueColor } : undefined}
      >
        {value}
      </span>
      <button
        type="button"
        aria-label={`Increase ${label}`}
        onClick={onInc}
        disabled={incDisabled}
        className="grid w-9 place-items-center font-display text-lg leading-none text-text transition-colors hover:enabled:bg-track disabled:opacity-40"
      >
        +
      </button>
    </div>
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
  const color = def ? chipColor(def.category) : 'var(--color-muted)';
  const rank = applied.rank && applied.rank > 1 ? ` ${applied.rank}` : '';
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border px-2 py-[2px] text-[11px]"
      style={{ borderColor: color, color, backgroundColor: alpha(color, 12) }}
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
          className="-mr-0.5 grid size-3.5 place-items-center rounded-full hover:bg-white/10"
        >
          <X className="size-3" />
        </button>
      )}
    </span>
  );
}

function PartyRow({
  player,
  onTapCondition,
}: {
  player: Player;
  onTapCondition: (id: string) => void;
}) {
  const dead = player.status === 'dead';
  const hurt =
    player.status !== 'active' || player.wounds < player.maxWounds || player.shock > 0;
  return (
    <div
      className="rounded-[5px] border border-l-[3px] px-3 py-[11px]"
      style={{
        backgroundColor: hurt ? '#171009' : '#120f09',
        borderColor: '#241d12',
        borderLeftColor: statusColor(player.status),
        opacity: dead ? 0.6 : 1,
      }}
    >
      <div className="flex items-center gap-2">
        <PIndexChip index={player.index} />
        <span
          className={cn(
            'min-w-0 flex-1 truncate font-display text-[14px] font-semibold text-text',
            dead && 'line-through',
          )}
        >
          {player.name}
        </span>
        <span
          className="shrink-0 text-[10px] font-semibold"
          style={{ color: statusColor(player.status) }}
        >
          {statusLabel(player.status)}
        </span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
        <MiniBar
          label="W"
          value={player.wounds}
          max={player.maxWounds}
          fillColor="var(--color-wounds)"
          numColor="#ff8085"
        />
        <MiniBar
          label="S"
          value={player.shock}
          max={player.maxShock}
          fillColor="var(--color-shock)"
          numColor="#7cc7ef"
        />
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
  fillColor,
  numColor,
}: {
  label: string;
  value: number;
  max: number;
  fillColor: string;
  numColor: string;
}) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] font-semibold" style={{ color: numColor }}>
        {label}
      </span>
      <div className="h-[5px] flex-1 overflow-hidden rounded-full bg-track">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: fillColor }} />
      </div>
      <span className="shrink-0 text-[10px] tabular-nums" style={{ color: numColor }}>
        {value}/{max}
      </span>
    </div>
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
        <path
          d="M8 2.2 L14.4 13.2 H1.6 Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
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

function EnemyRow({
  mob,
  onTapCondition,
}: {
  mob: MobPublicView;
  onTapCondition: (id: string) => void;
}) {
  const dead = mob.coarse === 'dead';
  const color = coarseColor(mob.coarse);
  return (
    <div
      className="rounded-[4px] border border-l-[3px] bg-panel px-[13px] py-[11px]"
      style={{ borderColor: 'var(--color-default)', borderLeftColor: color, opacity: dead ? 0.62 : 1 }}
    >
      <div className="flex items-center gap-2.5">
        <CoarseIcon coarse={mob.coarse} />
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-[14px] font-semibold text-text',
            dead && 'line-through',
          )}
        >
          {mob.label}
        </span>
        <span
          className="shrink-0 font-display text-[9px] font-semibold uppercase tracking-[1px]"
          style={{ color }}
        >
          {coarseLabel(mob.coarse)}
        </span>
      </div>
      {mob.conditions.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1 pl-[26px]">
          {mob.conditions.map((c, i) => (
            <ConditionChip key={c.id + i} applied={c} onTap={() => onTapCondition(c.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function fmtTime(tsSeconds: number): string {
  return new Date(tsSeconds * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
