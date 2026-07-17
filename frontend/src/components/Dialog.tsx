import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  /** Optional sticky footer (e.g. Cancel / Confirm action row). */
  footer?: ReactNode;
  /** Tailwind max-width class for the panel (default `max-w-md`). */
  widthClass?: string;
  children: ReactNode;
}

/**
 * Hand-rolled centered modal for the GM console (desktop) — the wider-screen sibling of
 * BottomSheet. Portaled to <body>, backdrop + Escape close, and a short unmount delay so
 * the exit transition plays. No deps beyond lucide's X. Used for the add-mob form and the
 * end-session / next-round confirmations.
 */
export function Dialog({ open, onClose, title, footer, widthClass, children }: DialogProps) {
  // `mounted` keeps the node through the exit animation; `shown` drives enter/exit.
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      const raf = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(raf);
    }
    setShown(false);
    const t = window.setTimeout(() => setMounted(false), 200);
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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
    >
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
          'relative flex max-h-[85dvh] w-full flex-col overflow-hidden rounded-2xl border border-strong bg-panel shadow-xl transition-all duration-200 ease-out',
          shown ? 'scale-100 opacity-100' : 'scale-[0.98] opacity-0',
          widthClass ?? 'max-w-md',
        )}
      >
        {title !== undefined && (
          <div className="flex items-center justify-between gap-3 border-b border-default px-5 py-3">
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
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="shrink-0 border-t border-default px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
