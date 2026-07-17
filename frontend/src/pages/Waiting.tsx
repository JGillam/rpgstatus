import { useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { claim } from '@/lib/api';
import { clearIdentity, clearPending, loadPending, saveIdentity } from '@/lib/identity';
import { POLL_MS } from '@/lib/useSessionState';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

type Phase = 'waiting' | 'ignored' | 'removed';

export default function Waiting() {
  const navigate = useNavigate();
  const pending = useMemo(() => loadPending(), []);
  const [phase, setPhase] = useState<Phase>('waiting');
  const doneRef = useRef(false);

  useEffect(() => {
    if (!pending || doneRef.current) return;
    let active = true;

    const poll = async () => {
      if (!active || doneRef.current || document.visibilityState === 'hidden') return;
      try {
        const res = await claim(pending.code, pending.playerId, pending.joinSecret);
        if (!active) return;
        if (res.presence === 'admitted') {
          doneRef.current = true;
          saveIdentity({
            code: pending.code,
            role: 'player',
            token: res.playerToken,
            playerId: pending.playerId,
            index: res.index,
            name: pending.name,
          });
          clearPending();
          navigate('/play', { replace: true });
        } else if (res.presence === 'ignored') {
          setPhase('ignored');
        } else if (res.presence === 'removed') {
          setPhase('removed');
        } else {
          setPhase('waiting');
        }
      } catch {
        // Transient network/API error — keep polling; the freshness of admission matters
        // more than surfacing every blip on this pre-admission screen.
      }
    };

    void poll();
    const interval = window.setInterval(poll, POLL_MS);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [pending, navigate]);

  if (!pending) return <Navigate to="/" replace />;

  const leave = () => {
    clearPending();
    clearIdentity();
    navigate('/', { replace: true });
  };

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-5 py-12">
      <header className="text-center">
        <h1 className="font-display text-2xl font-semibold tracking-widest text-gold">
          {pending.code}
        </h1>
        <p className="mt-1 text-sm text-muted">Joining as {pending.name}</p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>
            {phase === 'waiting' && 'Waiting for the GM'}
            {phase === 'ignored' && 'Not admitted yet'}
            {phase === 'removed' && 'Removed from the session'}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {phase === 'waiting' && (
            <div className="flex items-center gap-3 text-text-2">
              <span className="inline-block size-2.5 animate-pulse rounded-full bg-gold" aria-hidden />
              <span>The GM will admit you shortly. Keep this screen open.</span>
            </div>
          )}
          {phase === 'ignored' && (
            <p className="text-text-2">
              The GM hasn&apos;t admitted you. You can keep waiting, or leave and rejoin.
            </p>
          )}
          {phase === 'removed' && (
            <p className="text-text-2">You were removed from this session.</p>
          )}
          <Button variant="ghost" onClick={leave}>
            Leave
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
