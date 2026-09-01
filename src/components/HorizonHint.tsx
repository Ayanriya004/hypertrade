import { useEffect, useId, useRef, useState, type SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';

type Props = {
  hint: string;
};

type Pos = { top: number; left: number };

function measureTipPos(anchor: HTMLElement): Pos {
  const r = anchor.getBoundingClientRect();
  const pad = 12;
  const width = Math.min(300, window.innerWidth - pad * 2);
  let left = r.right - width;
  left = Math.max(pad, Math.min(left, window.innerWidth - width - pad));
  return { top: r.bottom + 8, left };
}

/**
 * "!" affordance for horizon copy. Native title tooltips fail on mobile
 * (and inside a parent card button), so we toggle a fixed popover on tap/click.
 */
export function HorizonHint({ hint }: Props) {
  const tipId = useId();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Pos | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (anchorRef.current?.contains(t)) return;
      const tip = document.getElementById(tipId);
      if (tip?.contains(t)) return;
      setOpen(false);
      setPos(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        setPos(null);
      }
    };
    const onDismiss = () => {
      setOpen(false);
      setPos(null);
    };
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onDismiss, true);
    window.addEventListener('resize', onDismiss);
    return () => {
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onDismiss, true);
      window.removeEventListener('resize', onDismiss);
    };
  }, [open, tipId]);

  const toggle = (e: SyntheticEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (open) {
      setOpen(false);
      setPos(null);
      return;
    }
    const el = anchorRef.current;
    if (!el) return;
    // Measure before open so the first paint isn't at (0,0).
    setPos(measureTipPos(el));
    setOpen(true);
  };

  return (
    <>
      <span
        ref={anchorRef}
        role="button"
        tabIndex={0}
        className={`chip-horizon-hint${open ? ' open' : ''}`}
        aria-label={hint}
        aria-expanded={open}
        aria-controls={tipId}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') toggle(e);
        }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        !
      </span>
      {open && pos
        ? createPortal(
            <div
              id={tipId}
              role="tooltip"
              className="chip-horizon-tip"
              style={{ top: pos.top, left: pos.left }}
            >
              {hint}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
