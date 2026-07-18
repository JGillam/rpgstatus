import { useMemo, useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { JOIN_CODE, LIMITS } from '@domain';
import { joinSession } from '@/lib/api';
import { loadIdentity, savePending } from '@/lib/identity';

/** Uppercase, strip non-alphanumerics, cap at the code length (prototype code field). */
function sanitizeCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, JOIN_CODE.length);
}

export default function Landing() {
  const navigate = useNavigate();

  // A confirmed identity skips the landing entirely (GM console / live player screen).
  const existing = useMemo(() => loadIdentity(), []);
  if (existing) {
    return <Navigate to={existing.role === 'gm' ? '/gm' : '/play'} replace />;
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[430px] flex-col justify-center gap-9 px-6 py-14">
      <header className="flex flex-col items-center text-center">
        <div
          aria-hidden
          className="h-[3px] w-14 rounded-full"
          style={{ background: 'linear-gradient(90deg,#c8901a,#ffc84a)', boxShadow: '0 0 14px rgba(240,180,41,0.5)' }}
        />
        <h1 className="mt-5 font-display text-[30px] font-bold leading-none tracking-[1px] text-text">
          WRATH <span className="text-gold">&amp;</span> GLORY
        </h1>
        <p className="mt-3 text-[14px] italic leading-[1.5] text-muted">
          One shared screen for your table — Glory, wounds and wrath, live.
        </p>
      </header>

      <StartSession onStart={() => navigate('/create')} />

      <Divider label="OR JOIN A GAME" />

      <JoinSession
        onPending={(code, playerId, joinSecret, name) => {
          savePending({ code, playerId, joinSecret, name });
          navigate('/waiting', { replace: true });
        }}
      />
    </main>
  );
}

function StartSession({ onStart }: { onStart: () => void }) {
  return (
    <div className="flex flex-col items-center gap-2">
      <button
        type="button"
        onClick={onStart}
        className="w-full rounded-[8px] bg-gold py-[15px] font-display text-[14px] font-bold tracking-[2px] text-on-gold transition-colors hover:bg-gold-hi"
        style={{ boxShadow: '0 0 22px rgba(240,180,41,0.35)' }}
      >
        START A SESSION
      </button>
      <p className="text-[12px] italic text-faint">As Game Master — opens your console</p>
    </div>
  );
}

function Divider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3" aria-hidden>
      <span className="h-px flex-1 bg-default" />
      <span className="font-display text-[10px] font-semibold tracking-[3px] text-faint">{label}</span>
      <span className="h-px flex-1 bg-default" />
    </div>
  );
}

function WarningTriangle() {
  return (
    <svg width={15} height={15} viewBox="0 0 16 16" aria-hidden style={{ flexShrink: 0 }}>
      <path
        d="M8 2.2 L14.4 13.2 H1.6 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <line x1="8" y1="6.2" x2="8" y2="9.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="8" cy="11.4" r="0.9" fill="currentColor" />
    </svg>
  );
}

function JoinSession({
  onPending,
}: {
  onPending: (code: string, playerId: string, joinSecret: string, name: string) => void;
}) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [codeError, setCodeError] = useState(false);

  const codeOk = code.length === JOIN_CODE.length;
  const nameOk = name.trim().length > 0;
  const canJoin = codeOk && nameOk && !busy;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!codeOk || !nameOk) return;
    setBusy(true);
    setCodeError(false);
    try {
      const res = await joinSession(code, name.trim());
      onPending(code, res.playerId, res.joinSecret, name.trim());
    } catch {
      // The screen has a single error affordance; any failure to reach a live session
      // (404 or otherwise) surfaces as the bad-code state.
      setCodeError(true);
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-4 rounded-[10px] border border-default bg-panel p-5"
    >
      <div className="flex items-center gap-2">
        <span aria-hidden className="text-[11px] leading-none text-gold">
          ◆
        </span>
        <span className="font-display text-[11px] font-semibold tracking-[2px] text-muted">
          JOIN A SESSION
        </span>
      </div>

      <div className="flex flex-col gap-2">
        <input
          value={code}
          onChange={(e) => {
            setCode(sanitizeCode(e.target.value));
            if (codeError) setCodeError(false);
          }}
          placeholder="CODE"
          aria-label="Join code"
          aria-invalid={codeError}
          autoCapitalize="characters"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          inputMode="text"
          maxLength={JOIN_CODE.length}
          className="w-full rounded-[8px] border bg-bg py-3 text-center font-display text-[34px] font-bold uppercase leading-none text-gold outline-none transition-colors placeholder:text-faint focus-visible:border-emphasis"
          style={{ letterSpacing: '14px', borderColor: codeError ? 'var(--color-red)' : 'var(--color-default)' }}
        />
        {codeError && (
          <p className="flex items-center gap-1.5 text-[12px]" style={{ color: 'var(--color-red)' }}>
            <WarningTriangle />
            That code doesn&apos;t match a live session.
          </p>
        )}
      </div>

      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Your name at the table"
        aria-label="Display name"
        autoComplete="off"
        maxLength={LIMITS.name.max}
        className="w-full rounded-[8px] border border-default bg-bg px-3.5 py-3 font-body text-[16px] text-text outline-none transition-colors placeholder:text-faint focus-visible:border-emphasis"
      />

      <button
        type="submit"
        disabled={!canJoin}
        className={
          canJoin
            ? 'w-full rounded-[8px] bg-gold py-3.5 font-display text-[13px] font-bold tracking-[1.5px] text-on-gold transition-colors hover:bg-gold-hi'
            : 'w-full cursor-not-allowed rounded-[8px] border border-default bg-transparent py-3.5 font-display text-[13px] font-bold tracking-[1.5px] text-faint'
        }
        style={canJoin ? { boxShadow: '0 0 18px rgba(240,180,41,0.25)' } : undefined}
      >
        {busy ? 'JOINING…' : 'JOIN'}
      </button>
    </form>
  );
}
