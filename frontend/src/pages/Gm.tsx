import { useMemo } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import type { GmSnapshot } from '@domain';
import { loadIdentity, clearIdentity } from '@/lib/identity';
import { useSessionState } from '@/lib/useSessionState';
import { FreshnessDot } from '@/components/FreshnessDot';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default function Gm() {
  const navigate = useNavigate();
  const identity = useMemo(() => loadIdentity(), []);

  const args = identity?.role === 'gm' ? { code: identity.code, token: identity.token } : null;
  const { snapshot, secondsAgo, updatedAt, error, loading } = useSessionState<GmSnapshot>(args);

  if (!identity || identity.role !== 'gm') return <Navigate to="/" replace />;

  const endSession = () => {
    clearIdentity();
    navigate('/', { replace: true });
  };

  return (
    <div className="min-h-dvh bg-bg">
      <header className="sticky top-0 z-10 border-b border-default bg-panel/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-4 px-5 py-3">
          <div className="flex flex-col">
            <span className="text-xs uppercase tracking-wide text-muted">Join code</span>
            <span className="font-display text-xl font-semibold tracking-[0.25em] text-gold">
              {identity.code}
            </span>
          </div>
          <div className="flex items-center gap-4">
            <FreshnessDot secondsAgo={secondsAgo} updatedAt={updatedAt} error={!!error} />
            <Button variant="ghost" size="sm" onClick={endSession}>
              Leave
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-5 py-6">
        {loading && !snapshot && <p className="text-muted">Loading session…</p>}
        {snapshot && <GmBoard snapshot={snapshot} />}
        {/* step 6: real GM console (counters, roster admit/kick, mob management, log) */}
      </main>
    </div>
  );
}

function GmBoard({ snapshot }: { snapshot: GmSnapshot }) {
  const { session, players, mobs } = snapshot;

  return (
    <>
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Round" value={session.round} />
        <Stat label="Glory" value={session.glory} accent="text-gold" />
        <Stat label="Ruin" value={session.ruin} accent="text-ruin" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            Roster <span className="text-muted">({players.length})</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {players.length === 0 && <p className="text-sm text-muted">No players have joined yet.</p>}
          {players.map((p) => (
            <div
              key={p.id}
              className="flex items-center justify-between rounded-md border border-default bg-raised px-3 py-2"
            >
              <span className="text-text">{p.name}</span>
              <span className="text-xs uppercase tracking-wide text-muted">{p.presence}</span>
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
        <CardContent>
          <p className="text-sm text-muted">
            {mobs.length === 0
              ? 'No mobs on the board.'
              : `${mobs.length} mob${mobs.length === 1 ? '' : 's'} tracked.`}
          </p>
        </CardContent>
      </Card>
    </>
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
