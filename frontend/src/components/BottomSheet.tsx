import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  /** Optional sticky footer (e.g. a Done / Export action row). */
  footer?: ReactNode;
  children: ReactNode;
}

/**
 * Hand-rolled mobile bottom sheet: a fixed backdrop + a panel that slides up from the
 * bottom of the (max-width) column. No deps — animation is CSS transition on translate /
 * opacity, with a short unmount delay so the exit animation plays. Closes on backdrop
 * tap or Escape. Portaled to <body> so it overlays the sticky header.
 */
export function BottomSheet({ open, onClose, title, footer, children }: BottomSheetProps) {
  // `mounted` keeps the node in the tree through the exit animation; `shown` drives the
  // enter/exit transition (toggled a frame after mount so the browser animates it).
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      const raf = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(raf);
    }
    setShown(false);
    const t = window.setTimeout(() => setMounted(false), 220);
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center" role="dialog" aria-modal="true">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className={cn(
          'absolute inset-0 bg-black/70 transition-opacity duration-200',
          shown ? 'opacity-100' : 'opacity-0',
        )}
      />
      <div
        className={cn(
          'relative flex max-h-[85dvh] w-full max-w-[430px] flex-col rounded-t-2xl border-t border-strong bg-panel shadow-xl transition-transform duration-200 ease-out',
          shown ? 'translate-y-0' : 'translate-y-full',
        )}
      >
        <div className="mx-auto mt-2.5 h-1.5 w-10 shrink-0 rounded-full bg-strong" aria-hidden />
        {title !== undefined && (
          <div className="flex items-center justify-between gap-3 px-5 pb-2 pt-3">
            <h2 className="font-display text-lg font-semibold tracking-wide text-text">{title}</h2>
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              className="grid size-9 place-items-center rounded-md text-muted hover:bg-raised hover:text-text"
            >
              <X className="size-5" />
            </button>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-3">{children}</div>
        {footer && (
          <div className="shrink-0 border-t border-default px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
