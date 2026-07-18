import { useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { claim } from '@/lib/api';
import { clearIdentity, clearPending, loadPending, saveIdentity } from '@/lib/identity';
import { POLL_MS } from '@/lib/useSessionState';
import { Emblem } from '@/components/Takeover';

type Phase = 'waiting' | 'declined';

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
          // Character setup comes first, then the live board.
          navigate('/setup', { replace: true });
        } else if (res.presence === 'ignored' || res.presence === 'removed') {
          setPhase('declined');
        } else {
          setPhase('waiting');
        }
      } catch {
        // Transient network/API blip before admission — keep polling; freshness of the
        // admit signal matters more than surfacing every hiccup on this pre-entry screen.
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

  const declined = phase === 'declined';

  return (
    <main className="relative mx-auto flex min-h-dvh w-full max-w-[430px] flex-col items-center justify-center gap-5 overflow-hidden px-6 py-14 text-center">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[340px]"
        style={{ background: 'radial-gradient(120% 60% at 50% -5%, rgba(240,180,41,0.06), transparent 42%)' }}
      />

      <div className="relative z-10 font-display text-[12px] font-bold leading-none tracking-[4px] text-muted">
        WRATH <span className="text-gold">&amp;</span> GLORY
      </div>

      {declined ? (
        <Emblem color="var(--color-red)">
          <svg width={30} height={30} viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
            <circle cx="16" cy="16" r="13" />
            <line x1="11" y1="11" x2="21" y2="21" strokeLinecap="round" />
            <line x1="21" y1="11" x2="11" y2="21" strokeLinecap="round" />
          </svg>
        </Emblem>
      ) : (
        <Emblem color="var(--color-gold)" ring>
          <svg width={22} height={22} viewBox="0 0 24 24" aria-hidden>
            <path d="M12 2 L22 12 L12 22 L2 12 Z" fill="currentColor" />
          </svg>
        </Emblem>
      )}

      <div className="relative z-10 flex flex-col gap-2">
        <h1 className="font-display text-[21px] font-bold leading-[1.2] tracking-[0.5px] text-text">
          {declined ? 'The GM did not admit you' : 'Waiting for the GM to admit you…'}
        </h1>
        <p className="text-[13px] leading-[1.55] text-muted">
          {declined
            ? "You weren't let into this session. Check with your table, then try the code again."
            : "You'll drop straight into the table the moment they let you in."}
        </p>
      </div>

      <div
        className="relative z-10 flex items-center gap-2.5 transition-opacity"
        style={{ opacity: declined ? 0.5 : 1 }}
      >
        <span className="rounded-[4px] border border-default px-2.5 py-1 font-display text-[14px] font-bold tracking-[3px] text-gold">
          {pending.code}
        </span>
        <span className="text-[13px] text-muted">{pending.name}</span>
      </div>

      {declined ? (
        <button
          type="button"
          onClick={leave}
          className="relative z-10 mt-1 rounded-[6px] bg-gold px-[22px] py-3 font-display text-[12px] font-bold leading-none tracking-[1.5px] text-on-gold transition-colors hover:bg-gold-hi"
          style={{ boxShadow: '0 0 20px rgba(240,180,41,0.28)' }}
        >
          ▸ BACK TO START
        </button>
      ) : (
        <button
          type="button"
          onClick={leave}
          className="relative z-10 text-[13px] text-muted underline underline-offset-4 transition-colors hover:text-text"
        >
          Leave
        </button>
      )}
    </main>
  );
}
