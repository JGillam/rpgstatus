import type { ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';

// Full-screen lifecycle takeovers (SPEC §7.10) shared by the player screen and the GM
// console: removed-by-GM, session-ended, session-expired/token-invalid — plus the
// transient reconnecting banner. All dark-40K, centered, gold hero button. No new deps.

/** color-mix alpha helper — works with both `var(--color-…)` and hex colours. */
const alpha = (color: string, pct: number): string =>
  `color-mix(in srgb, ${color} ${pct}%, transparent)`;

// ---------------------------------------------------------------------------
// Emblem — a 64px ringed circle holding a glyph. Reused by the Waiting screen
// (pulsing admit ring) and the takeovers below (static status glyph).
// ---------------------------------------------------------------------------

export function Emblem({
  color,
  ring,
  children,
}: {
  color: string;
  /** Render the expanding "waitring" pulse behind the circle (waiting-to-be-admitted). */
  ring?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="relative grid size-16 place-items-center">
      {ring && (
        <>
          <span
            aria-hidden
            className="absolute inset-0 rounded-full border-2"
            style={{ borderColor: color, animation: 'waitring 1.9s ease-out infinite' }}
          />
          <span
            aria-hidden
            className="absolute inset-0 rounded-full border-2"
            style={{
              borderColor: color,
              animation: 'waitring 1.9s ease-out infinite',
              animationDelay: '0.95s',
            }}
          />
        </>
      )}
      <span
        className="relative grid size-16 place-items-center rounded-full border-2"
        style={{ borderColor: color, color, background: alpha(color, 8), boxShadow: `0 0 26px ${alpha(color, 30)}` }}
      >
        {children}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status glyphs (hand-drawn to match the app's inline-SVG coarse icons).
// ---------------------------------------------------------------------------

const glyphProps = {
  width: 30,
  height: 30,
  viewBox: '0 0 32 32',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  'aria-hidden': true,
} as const;

/** Circle-with-minus — removed from the session. */
function CircleMinusGlyph() {
  return (
    <svg {...glyphProps}>
      <circle cx="16" cy="16" r="13" />
      <line x1="9.5" y1="16" x2="22.5" y2="16" strokeLinecap="round" />
    </svg>
  );
}

/** Circle-with-× — session ended. */
function CircleXGlyph() {
  return (
    <svg {...glyphProps}>
      <circle cx="16" cy="16" r="13" />
      <line x1="11" y1="11" x2="21" y2="21" strokeLinecap="round" />
      <line x1="21" y1="11" x2="11" y2="21" strokeLinecap="round" />
    </svg>
  );
}

/** Hollow hourglass — session expired. */
function HourglassGlyph() {
  return (
    <svg {...glyphProps} strokeLinejoin="round">
      <path d="M9 6 L23 6 L16 16 L23 26 L9 26 L16 16 Z" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Takeover — the full-screen terminal state.
// ---------------------------------------------------------------------------

export type TakeoverVariant = 'removed' | 'ended' | 'expired';

interface VariantSpec {
  color: string;
  glyph: ReactNode;
  title: string;
  body: string;
}

const VARIANTS: Record<TakeoverVariant, VariantSpec> = {
  removed: {
    color: 'var(--color-red)',
    glyph: <CircleMinusGlyph />,
    title: 'Removed from the session',
    body: 'The Game Master has removed you. Your character has been taken off the board.',
  },
  ended: {
    color: 'var(--color-dead)',
    glyph: <CircleXGlyph />,
    title: 'Session ended',
    body: 'The Game Master has closed the session. The board is cleared and the join code retired.',
  },
  expired: {
    color: 'var(--color-gold)',
    glyph: <HourglassGlyph />,
    title: 'Session expired',
    body: 'This session went quiet and its code has expired. Ask your Game Master to start a new one.',
  },
};

export function Takeover({
  variant,
  onBack,
  backLabel = '▸ BACK TO START',
}: {
  variant: TakeoverVariant;
  onBack: () => void;
  backLabel?: string;
}) {
  const spec = VARIANTS[variant];
  return (
    <div className="relative grid min-h-dvh place-items-center overflow-hidden bg-bg-player px-6 text-center">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[340px]"
        style={{ background: 'radial-gradient(120% 60% at 50% -5%, rgba(240,180,41,0.06), transparent 42%)' }}
      />
      <div className="relative z-10 flex max-w-[380px] flex-col items-center">
        <div className="mb-7 font-display text-[12px] font-bold leading-none tracking-[4px] text-muted">
          WRATH <span className="text-gold">&amp;</span> GLORY
        </div>
        <Emblem color={spec.color}>{spec.glyph}</Emblem>
        <h1 className="mt-6 font-display text-[24px] font-bold leading-[1.15] tracking-[0.5px] text-text">
          {spec.title}
        </h1>
        <p className="mt-3 text-[14px] leading-[1.6] text-muted">{spec.body}</p>
        <button
          type="button"
          onClick={onBack}
          className="mt-7 rounded-[6px] bg-gold px-[22px] py-3.5 font-display text-[12px] font-bold leading-none tracking-[1.5px] text-on-gold transition-colors hover:bg-gold-hi"
          style={{ boxShadow: '0 0 20px rgba(240,180,41,0.28)' }}
        >
          {backLabel}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ReconnectingBanner — transient overlay; the last snapshot stays visible below.
// ---------------------------------------------------------------------------

export function ReconnectingBanner() {
  const orange = 'var(--color-orange)';
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center px-3 pt-3">
      <div
        className="flex items-center gap-3 rounded-[8px] border px-4 py-2.5 shadow-[0_10px_30px_-10px_rgba(0,0,0,0.8)]"
        style={{ background: '#1b1206', borderColor: alpha(orange, 45) }}
        role="status"
      >
        <span
          className="size-2.5 shrink-0 animate-pulse rounded-full"
          style={{ background: orange, boxShadow: `0 0 8px ${orange}` }}
          aria-hidden
        />
        <div className="flex min-w-0 flex-col">
          <span className="font-display text-[11px] font-semibold leading-tight tracking-[0.5px]" style={{ color: orange }}>
            Connection lost — reconnecting…
          </span>
          <span className="text-[11px] italic leading-tight text-muted">
            Your changes are saved · play continues.
          </span>
        </div>
        <RefreshCw className="size-4 shrink-0 animate-spin" style={{ color: orange, animationDuration: '1.6s' }} />
      </div>
    </div>
  );
}
