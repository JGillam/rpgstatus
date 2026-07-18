import { useMemo, useState, type ReactNode } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { DEFAULTS, LIMITS } from '@domain';
import { ApiError, updatePlayer } from '@/lib/api';
import { loadIdentity } from '@/lib/identity';

/** Character setup — a just-admitted player sets their limits before dropping into /play. */
export default function Setup() {
  const navigate = useNavigate();
  const identity = useMemo(() => loadIdentity(), []);

  if (!identity || identity.role !== 'player' || !identity.playerId) {
    return <Navigate to="/" replace />;
  }

  return (
    <SetupForm
      code={identity.code}
      token={identity.token}
      playerId={identity.playerId}
      name={identity.name ?? 'you'}
      onDone={() => navigate('/play', { replace: true })}
    />
  );
}

function SetupForm({
  code,
  token,
  playerId,
  name,
  onDone,
}: {
  code: string;
  token: string;
  playerId: string;
  name: string;
  onDone: () => void;
}) {
  const [maxWounds, setMaxWounds] = useState<number>(DEFAULTS.player.maxWounds);
  const [maxShock, setMaxShock] = useState<number>(DEFAULTS.player.maxShock);
  const [wrath, setWrath] = useState<number>(DEFAULTS.player.wrath);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const takePlace = async () => {
    setBusy(true);
    setError(null);
    try {
      // Seed the current tracks full at the max the player just chose.
      await updatePlayer(code, token, playerId, {
        maxWounds,
        maxShock,
        wrath,
        wounds: maxWounds,
        shock: maxShock,
      });
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? `Could not save (${e.status}).` : 'Could not save. Try again.');
      setBusy(false);
    }
  };

  return (
    <main className="relative mx-auto flex min-h-dvh w-full max-w-[430px] flex-col justify-center gap-6 overflow-hidden px-6 py-14">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[300px]"
        style={{ background: 'radial-gradient(120% 60% at 50% -5%, rgba(240,180,41,0.06), transparent 42%)' }}
      />

      <header className="relative z-10">
        <div className="font-display text-[11px] font-semibold tracking-[2px] text-gold">
          JOINING {code} · {name}
        </div>
        <h1 className="mt-2 font-display text-[25px] font-bold leading-[1.1] tracking-[0.5px] text-text">
          Take your place
        </h1>
        <p className="mt-2 text-[13px] leading-[1.55] text-muted">
          Set your character&apos;s limits. You can fine-tune everything once you&apos;re at the table.
        </p>
      </header>

      <div className="relative z-10 flex flex-col gap-3">
        <SetupCard
          label="MAX WOUNDS"
          color="var(--color-wounds)"
          description="Your total health before you go down."
          value={maxWounds}
          min={LIMITS.maxWounds.min}
          max={LIMITS.maxWounds.max}
          onChange={setMaxWounds}
        />
        <SetupCard
          label="MAX SHOCK"
          color="var(--color-shock)"
          description="The fatigue and fear you can absorb."
          value={maxShock}
          min={LIMITS.maxShock.min}
          max={LIMITS.maxShock.max}
          onChange={setMaxShock}
        />
        <SetupCard
          label="STARTING WRATH"
          color="var(--color-wrath)"
          description="Personal Wrath you begin play with (0–6)."
          value={wrath}
          min={LIMITS.wrath.min}
          max={LIMITS.wrath.max}
          onChange={setWrath}
        />
      </div>

      <div className="relative z-10 flex flex-col items-center gap-2">
        <button
          type="button"
          onClick={takePlace}
          disabled={busy}
          className="w-full rounded-[8px] bg-gold py-[15px] font-display text-[14px] font-bold tracking-[1.5px] text-on-gold transition-colors hover:bg-gold-hi disabled:opacity-60"
          style={{ boxShadow: '0 0 22px rgba(240,180,41,0.35)' }}
        >
          {busy ? 'TAKING YOUR PLACE…' : 'TAKE YOUR PLACE'}
        </button>
        <p className="text-[12px] italic text-faint">Opens your live player screen.</p>
        {error && <p className="text-[13px] text-wounds">{error}</p>}
      </div>
    </main>
  );
}

function SetupCard({
  label,
  color,
  description,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  color: string;
  description: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-[8px] border border-default bg-panel px-4 py-3.5">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="flex items-center gap-1.5">
          <span className="size-2 shrink-0 rounded-full" style={{ background: color }} aria-hidden />
          <span className="font-display text-[11px] font-semibold tracking-[1.5px] text-text-2">
            {label}
          </span>
        </span>
        <span className="text-[11px] italic leading-[1.4] text-muted">{description}</span>
      </div>
      <div className="inline-flex shrink-0 items-stretch overflow-hidden rounded-[6px] border border-strong">
        <StepButton label={`Decrease ${label}`} onClick={() => onChange(Math.max(min, value - 1))} disabled={value <= min}>
          −
        </StepButton>
        <span
          className="grid min-w-11 place-items-center border-x border-strong px-1 font-display text-[24px] font-bold tabular-nums"
          style={{ color }}
        >
          {value}
        </span>
        <StepButton label={`Increase ${label}`} onClick={() => onChange(Math.min(max, value + 1))} disabled={value >= max}>
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
      className="grid w-10 place-items-center font-display text-lg leading-none text-text transition-colors hover:enabled:bg-track disabled:opacity-40"
    >
      {children}
    </button>
  );
}
