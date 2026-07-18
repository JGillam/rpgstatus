import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
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
    <main className="mx-auto flex min-h-dvh w-full max-w-[430px] flex-col px-[22px] pb-10 pt-9">
      <header className="flex flex-col items-center text-center">
        <div
          aria-hidden
          className="h-[2px] w-14"
          style={{ background: 'linear-gradient(90deg,transparent,#f0b429,transparent)' }}
        />
        <h1 className="mt-[18px] font-display text-[30px] font-bold leading-none tracking-[3px] text-text">
          WRATH <span className="text-gold">&amp;</span> GLORY
        </h1>
        <p className="mt-3 text-[12px] italic leading-[1.45] text-muted">
          One shared screen for your table — Glory, wounds and wrath, live.
        </p>
      </header>

      <JoinSession
        onPending={(code, playerId, joinSecret, name) => {
          savePending({ code, playerId, joinSecret, name });
          navigate('/waiting', { replace: true });
        }}
      />

      <Divider label="RUNNING THE GAME?" />

      <StartSession onStart={() => navigate('/create')} />

      <SiteFooter />
    </main>
  );
}

function StartSession({ onStart }: { onStart: () => void }) {
  return (
    <div className="mt-3.5 flex flex-col gap-[9px]">
      <button
        type="button"
        onClick={onStart}
        className="flex w-full items-center justify-center gap-[9px] rounded-[8px] border border-default bg-transparent py-4 font-display text-[12px] font-semibold tracking-[1.5px] text-text-2 transition-colors hover:border-emphasis hover:bg-[#120e08] hover:text-text"
      >
        <ConsoleIcon />
        START A SESSION
      </button>
      <p className="text-center text-[11px] italic leading-[1.45] text-faint">
        Opens the Game Master&apos;s console — best on a larger screen.
      </p>
    </div>
  );
}

function ConsoleIcon() {
  return (
    <svg
      width={15}
      height={15}
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--color-gold)"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x={3} y={4} width={18} height={13} rx={1} />
      <line x1={8} y1={21} x2={16} y2={21} />
      <line x1={12} y1={17} x2={12} y2={21} />
    </svg>
  );
}

function Divider({ label }: { label: string }) {
  return (
    <div className="mt-6 flex items-center gap-3" aria-hidden>
      <span className="h-px flex-1 bg-[#241d12]" />
      <span className="font-display text-[9px] font-semibold tracking-[2px] text-faint">{label}</span>
      <span className="h-px flex-1 bg-[#241d12]" />
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
      className="mt-8 rounded-[11px] border border-strong bg-panel px-4 pb-[18px] pt-5"
      style={{ boxShadow: '0 0 34px rgba(240,180,41,0.09)' }}
    >
      <div className="font-display text-[10px] font-semibold leading-none tracking-[3px] text-gold">
        ◆ JOIN YOUR TABLE
      </div>
      <p className="mt-2 text-[12px] leading-[1.45] text-muted">
        Enter the code your Game Master shared to take your seat at the table.
      </p>

      <div className="mt-4">
        <div className="mb-[9px] font-display text-[9px] font-semibold leading-none tracking-[2px] text-muted">
          JOIN CODE
        </div>
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
          className="w-full rounded-[8px] border bg-bg py-[18px] text-center font-display text-[34px] font-bold uppercase leading-none text-gold outline-none transition-colors placeholder:text-faint focus-visible:border-emphasis"
          style={{
            letterSpacing: '14px',
            textIndent: '14px',
            borderColor: codeError ? '#c0403f' : 'var(--color-strong)',
            boxShadow: codeError ? '0 0 0 3px rgba(192,42,47,0.18)' : 'none',
          }}
        />
        {codeError && (
          <p className="mt-2.5 flex items-center gap-[7px] text-[12px]" style={{ color: '#ff9498' }}>
            <WarningTriangle />
            That code doesn&apos;t match a live session.
          </p>
        )}
      </div>

      <div className="mt-4">
        <div className="mb-[9px] font-display text-[9px] font-semibold leading-none tracking-[2px] text-muted">
          DISPLAY NAME
        </div>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name at the table"
          aria-label="Display name"
          autoComplete="off"
          maxLength={LIMITS.name.max}
          className="w-full rounded-[8px] border border-strong bg-bg p-3.5 font-body text-[16px] text-text outline-none transition-colors placeholder:text-faint focus-visible:border-emphasis"
        />
      </div>

      <button
        type="submit"
        disabled={!canJoin}
        className={
          canJoin
            ? 'mt-4 w-full rounded-[7px] bg-gold py-4 font-display text-[14px] font-bold tracking-[2px] text-on-gold transition-colors hover:bg-gold-hi'
            : 'mt-4 w-full cursor-not-allowed rounded-[7px] bg-[#c9a13a] py-4 font-display text-[14px] font-bold tracking-[2px] text-on-gold'
        }
        style={canJoin ? { boxShadow: '0 0 20px rgba(240,180,41,0.28)' } : undefined}
      >
        {busy ? 'JOINING…' : 'JOIN'}
      </button>
    </form>
  );
}

/** Disclaimer bullets for the "About this site" expandable (design: Entry & Join footer). */
const ABOUT_ITEMS: ReactNode[] = [
  <>
    Unofficial fan project. Not affiliated with, endorsed by, or licensed by Games Workshop or
    Cubicle 7. <i>Wrath &amp; Glory</i> and <i>Warhammer 40,000</i> are trademarks of their
    respective owners.
  </>,
  <>Provided as-is, with no warranty of any kind. Use at your own risk.</>,
  <>
    No accounts, no personal data collected. The names and stats you enter exist only to run your
    session and are deleted automatically within 72 hours. By using this site you consent to this
    temporary storage. Anonymous, aggregate usage counts (sessions, players per session, rounds)
    are kept — never names or codes.
  </>,
  <>
    Open source under the AGPL-3.0 license. Browse the code, report bugs, suggest features, or run
    your own copy:{' '}
    <a
      href="https://github.com/JGillam/rpgstatus"
      target="_blank"
      rel="noreferrer"
      className="underline underline-offset-2 transition-colors hover:text-muted"
    >
      github.com/JGillam/rpgstatus
    </a>
    .
  </>,
];

function SiteFooter() {
  const [open, setOpen] = useState(false);
  return (
    <footer className="mt-auto pt-[30px]">
      <div
        aria-hidden
        className="h-px"
        style={{ background: 'linear-gradient(90deg,transparent,#332b1b 22%,#332b1b 78%,transparent)' }}
      />
      <div className="mt-[18px] flex flex-col items-center text-center">
        <div className="font-display text-[8px] font-semibold leading-[1.4] tracking-[2.5px] text-[#5f5745]">
          UNOFFICIAL FAN PROJECT
        </div>
        <p className="mt-[9px] max-w-[300px] text-[11px] italic leading-[1.55] text-faint">
          Not affiliated with, endorsed by, or licensed by Games Workshop or Cubicle 7.
        </p>
        <div className="mt-[15px] flex items-center gap-2">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="inline-flex items-center gap-1.5 rounded-full border border-[#2e2718] bg-transparent px-3.5 py-2 font-display text-[9px] font-semibold leading-none tracking-[1.5px] text-[#8a8069] transition-colors hover:border-strong hover:text-muted"
          >
            ABOUT THIS SITE
            <svg
              width={11}
              height={11}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.4}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
              style={{ transition: 'transform 0.25s ease', transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}
            >
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
          <a
            href="https://github.com/JGillam/rpgstatus"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-full border border-[#2e2718] bg-transparent px-3.5 py-2 font-display text-[9px] font-semibold leading-none tracking-[1.5px] text-[#8a8069] transition-colors hover:border-strong hover:text-muted"
          >
            SOURCE &amp; FEEDBACK
            <svg
              width={10}
              height={10}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.4}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M7 17L17 7M9 7h8v8" />
            </svg>
          </a>
        </div>
      </div>
      {open && (
        <div
          className="mt-3.5 rounded-[9px] border border-[#241d12] bg-[#100c07] px-[15px] pb-4 pt-[15px]"
          style={{ animation: 'fadeup 0.3s ease both' }}
        >
          {ABOUT_ITEMS.map((item, i) => (
            <div key={i} className={i === 0 ? 'flex gap-2.5' : 'mt-[11px] flex gap-2.5'}>
              <span aria-hidden className="flex-none text-[9px] leading-[1.85] text-[#5f5745]">
                ◆
              </span>
              <p className="m-0 text-[11px] leading-[1.6] text-[#8a8069]">{item}</p>
            </div>
          ))}
        </div>
      )}
    </footer>
  );
}
