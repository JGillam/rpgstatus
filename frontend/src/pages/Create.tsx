import { useMemo, useState, type ReactNode } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { DEFAULTS, LIMITS } from '@domain';
import { ApiError, createSession } from '@/lib/api';
import { loadIdentity, saveIdentity } from '@/lib/identity';

/** GM "Create session" — the opening-state form. Forges a live session and console. */
export default function Create() {
  const navigate = useNavigate();
  const existing = useMemo(() => loadIdentity(), []);
  if (existing) {
    return <Navigate to={existing.role === 'gm' ? '/gm' : '/play'} replace />;
  }

  return <CreateForm onCreated={() => navigate('/gm', { replace: true })} />;
}

function CreateForm({ onCreated }: { onCreated: () => void }) {
  const [chapterName, setChapterName] = useState('');
  const [glory, setGlory] = useState<number>(DEFAULTS.session.glory);
  const [ruin, setRuin] = useState<number>(DEFAULTS.session.ruin);
  const [showRuin, setShowRuin] = useState<boolean>(DEFAULTS.session.showRuin);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const forge = async () => {
    setBusy(true);
    setError(null);
    try {
      const trimmed = chapterName.trim();
      const res = await createSession({
        chapterName: trimmed || undefined,
        glory,
        ruin,
        showRuin,
      });
      saveIdentity({ code: res.code, role: 'gm', token: res.gmToken });
      onCreated();
    } catch (e) {
      setError(e instanceof ApiError ? `Could not forge a session (${e.status}).` : 'Could not forge a session.');
      setBusy(false);
    }
  };

  return (
    <main className="relative grid min-h-dvh place-items-center overflow-hidden bg-bg px-4 py-10">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ background: 'radial-gradient(130% 90% at 50% -10%, rgba(240,180,41,0.05), transparent 45%)' }}
      />

      <div className="relative w-full max-w-[522px] overflow-hidden rounded-[10px] border border-default bg-panel shadow-[0_24px_60px_-24px_rgba(0,0,0,0.8)]">
        <div
          aria-hidden
          className="h-[2px] w-full"
          style={{ background: 'linear-gradient(90deg,transparent,#f0b429,transparent)' }}
        />
        <div className="flex flex-col gap-5 p-6 sm:p-8">
          <div>
            <div className="flex items-center gap-2">
              <span aria-hidden className="text-[11px] leading-none text-gold">
                ◆
              </span>
              <span className="font-display text-[11px] font-semibold tracking-[2px] text-muted">
                NEW SESSION
              </span>
            </div>
            <h1 className="mt-3 font-display text-[27px] font-bold leading-[1.1] tracking-[0.5px] text-text">
              Forge a new session
            </h1>
            <p className="mt-2 text-[13px] leading-[1.55] text-muted">
              Set the table&apos;s opening state. You can change any of this at any time once the
              console is open.
            </p>
          </div>

          <label className="flex flex-col gap-2">
            <FieldLabel>CHAPTER NAME</FieldLabel>
            <input
              value={chapterName}
              onChange={(e) => setChapterName(e.target.value)}
              maxLength={LIMITS.chapterName.max}
              placeholder="e.g. The Gilded Reliquary"
              className="w-full rounded-[8px] border border-default bg-bg px-3.5 py-2.5 font-body text-[15px] text-text outline-none transition-colors placeholder:text-faint focus-visible:border-emphasis"
            />
          </label>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <ResourceCard
              label="GLORY"
              color="var(--color-gold)"
              description="Party's shared momentum"
              value={glory}
              onChange={setGlory}
            />
            <ResourceCard
              label="RUIN"
              color="var(--color-violet)"
              description="The GM's dark resource"
              value={ruin}
              onChange={setRuin}
            />
          </div>

          <div className="flex items-center justify-between gap-3 rounded-[8px] border border-default bg-bg px-3.5 py-3">
            <div className="flex flex-col gap-0.5">
              <span className="font-display text-[11px] font-semibold tracking-[1.5px] text-text-2">
                SHOW RUIN TO PLAYERS
              </span>
              <span className="text-[11px] italic text-faint">
                {showRuin ? 'Shown' : 'Hidden'}
              </span>
            </div>
            <Toggle on={showRuin} onToggle={() => setShowRuin((v) => !v)} label="Show Ruin to players" />
          </div>

          <div className="flex flex-col items-center gap-2 pt-1">
            <button
              type="button"
              onClick={forge}
              disabled={busy}
              className="w-full rounded-[8px] bg-gold py-[15px] font-display text-[14px] font-bold tracking-[1.5px] text-on-gold transition-colors hover:bg-gold-hi disabled:opacity-60"
              style={{ boxShadow: '0 0 22px rgba(240,180,41,0.3)' }}
            >
              {busy ? 'FORGING…' : '▸ FORGE SESSION'}
            </button>
            <p className="text-[12px] italic text-faint">Mints a join code you can share with your table.</p>
            {error && <p className="text-[13px] text-wounds">{error}</p>}
          </div>
        </div>
      </div>
    </main>
  );
}

function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <span className="font-display text-[10px] font-semibold tracking-[2px] text-muted">{children}</span>
  );
}

/** Glory / Ruin opening-value card: dot+label, one-line description, centered −/n/+ stepper. */
function ResourceCard({
  label,
  color,
  description,
  value,
  onChange,
}: {
  label: string;
  color: string;
  description: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-[8px] border border-default bg-bg px-4 py-3.5">
      <div className="flex flex-col gap-1">
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-full" style={{ background: color }} aria-hidden />
          <span className="font-display text-[11px] font-semibold tracking-[1.5px]" style={{ color }}>
            {label}
          </span>
        </span>
        <span className="text-[11px] italic text-muted">{description}</span>
      </div>
      <div className="flex items-center justify-center gap-3">
        <StepButton label={`Decrease ${label}`} onClick={() => onChange(Math.max(LIMITS.counter.min, value - 1))} disabled={value <= LIMITS.counter.min}>
          −
        </StepButton>
        <span className="min-w-[2ch] text-center font-display text-[34px] font-bold leading-none tabular-nums" style={{ color }}>
          {value}
        </span>
        <StepButton label={`Increase ${label}`} onClick={() => onChange(value + 1)}>
          +
        </StepButton>
      </div>
    </div>
  );
}

function StepButton({
  children,
  label,
  onClick,
  disabled,
}: {
  children: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="grid size-9 place-items-center rounded-[6px] border border-strong bg-raised font-display text-lg leading-none text-text transition-colors hover:enabled:bg-track disabled:opacity-40"
    >
      {children}
    </button>
  );
}

/** Real toggle switch (track + knob); violet when on. */
function Toggle({ on, onToggle, label }: { on: boolean; onToggle: () => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onToggle}
      className="relative h-[26px] w-[46px] shrink-0 rounded-full border transition-colors"
      style={{
        background: on ? 'var(--color-violet)' : 'var(--color-track)',
        borderColor: on ? 'var(--color-violet)' : 'var(--color-strong)',
      }}
    >
      <span
        className="absolute top-1/2 size-[18px] -translate-y-1/2 rounded-full bg-bg shadow transition-[left]"
        style={{ left: on ? '23px' : '3px' }}
        aria-hidden
      />
    </button>
  );
}
