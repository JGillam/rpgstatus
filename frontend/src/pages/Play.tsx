import { useMemo } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import type { MobPublicView, Player, PlayerSnapshot } from '@domain';
import { clearIdentity, loadIdentity } from '@/lib/identity';
import { useSessionState } from '@/lib/useSessionState';
import { coarseColor, coarseLabel, statusColor, statusLabel } from '@/lib/theme';
import { FreshnessDot } from '@/components/FreshnessDot';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default function Play() {
  const navigate = useNavigate();
  const identity = useMemo(() => loadIdentity(), []);

  const args = identity?.role === 'player' ? { code: identity.code, token: identity.token } : null;
  const { snapshot, secondsAgo, updatedAt, error, loading } = useSessionState<PlayerSnapshot>(args);

  if (!identity || identity.role !== 'player') return <Navigate to="/" replace />;

  const leave = () => {
    clearIdentity();
    navigate('/', { replace: true });
  };

  return (
    <div className="min-h-dvh bg-bg-player">
      <header className="sticky top-0 z-10 border-b border-default bg-panel/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-2xl items-center justify-between gap-4 px-5 py-3">
          <div className="flex flex-col">
            <span className="text-xs uppercase tracking-wide text-muted">Session</span>
            <span className="font-display text-lg font-semibold tracking-[0.2em] text-gold">
              {identity.code}
            </span>
          </div>
          <div className="flex items-center gap-4">
            <FreshnessDot secondsAgo={secondsAgo} updatedAt={updatedAt} error={!!error} />
            <Button variant="ghost" size="sm" onClick={leave}>
              Leave
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-5 py-6">
        {loading && !snapshot && <p className="text-muted">Loading session…</p>}
        {snapshot && <PlayerBoard snapshot={snapshot} />}
        {/* step 5: real player screen (your character controls, conditions, glory push) */}
      </main>
    </div>
  );
}

function PlayerBoard({ snapshot }: { snapshot: PlayerSnapshot }) {
  const { session, players, mobs, youId } = snapshot;
  const you = players.find((p) => p.id === youId) ?? null;
  const others = players.filter((p) => p.id !== youId);

  return (
    <>
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Round" value={session.round} />
        <Stat label="Glory" value={session.glory} accent="text-gold" />
        {session.ruin !== null && <Stat label="Ruin" value={session.ruin} accent="text-ruin" />}
      </div>

      {you && <YouCard you={you} />}

      <Card>
        <CardHeader>
          <CardTitle>
            Party <span className="text-muted">({others.length})</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {others.length === 0 && <p className="text-sm text-muted">No other players yet.</p>}
          {others.map((p) => (
            <div
              key={p.id}
              className="flex items-center justify-between rounded-md border border-default bg-raised px-3 py-2"
            >
              <span className="text-text">{p.name}</span>
              <span className="text-xs font-medium" style={{ color: statusColor(p.status) }}>
                {statusLabel(p.status)}
              </span>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            Enemies <span className="text-muted">({mobs.length})</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {mobs.length === 0 && <p className="text-sm text-muted">No enemies revealed.</p>}
          {mobs.map((m) => (
            <MobRow key={m.id} mob={m} />
          ))}
        </CardContent>
      </Card>
    </>
  );
}

function YouCard({ you }: { you: Player }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span>{you.name}</span>
          <span className="text-sm font-medium" style={{ color: statusColor(you.status) }}>
            {statusLabel(you.status)}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-3 gap-3">
        <Track label="Wounds" value={you.wounds} max={you.maxWounds} accent="text-wounds" />
        <Track label="Shock" value={you.shock} max={you.maxShock} accent="text-shock" />
        <Track label="Wrath" value={you.wrath} accent="text-wrath" />
      </CardContent>
    </Card>
  );
}

function MobRow({ mob }: { mob: MobPublicView }) {
  return (
    <div className="flex items-center justify-between rounded-md border border-default bg-raised px-3 py-2">
      <div className="flex flex-col">
        <span className="text-text">{mob.label}</span>
        <span className="text-xs uppercase tracking-wide text-faint">{mob.tier}</span>
      </div>
      <span className="text-xs font-medium" style={{ color: coarseColor(mob.coarse) }}>
        {coarseLabel(mob.coarse)}
      </span>
    </div>
  );
}

function Track({
  label,
  value,
  max,
  accent,
}: {
  label: string;
  value: number;
  max?: number;
  accent?: string;
}) {
  return (
    <div className="flex flex-col items-center gap-1 rounded-md border border-default bg-track py-3">
      <span className="text-xs uppercase tracking-wide text-muted">{label}</span>
      <span className={`font-display text-2xl font-bold ${accent ?? 'text-text'}`}>
        {value}
        {max !== undefined && <span className="text-sm text-faint">/{max}</span>}
      </span>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: string }) {
  return (
    <div className="flex flex-col items-center gap-1 rounded-lg border border-default bg-panel py-4">
      <span className="text-xs uppercase tracking-wide text-muted">{label}</span>
      <span className={`font-display text-3xl font-bold ${accent ?? 'text-text'}`}>{value}</span>
    </div>
  );
}
