/**
 * EthanolGoldenTicket — premium introduction popup for the Ethanol
 * Contamination Check.
 *
 * Design is an ORIGINAL Vroomie treatment of a "premium golden admission
 * ticket" (metallic gradient, embossed border, perforation notches). It
 * deliberately borrows no third-party artwork, characters, branding or
 * typography.
 *
 * UX contract:
 *   * Never traps the user — ×, "Not now", backdrop click and Escape all close.
 *   * Once dismissed it does not reappear for the rest of the session.
 *   * Lightweight animation only; respects prefers-reduced-motion.
 */
import React, { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { X, FlaskConical } from 'lucide-react';

export default function EthanolGoldenTicket({ open, onCheckNow, onDismiss }) {
  const panelRef = useRef(null);
  const closeRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onDismiss(); };
    window.addEventListener('keydown', onKey);
    closeRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onDismiss]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[1100] flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm"
      onClick={onDismiss}
      role="presentation"
      style={{ paddingTop: 'max(1rem, env(safe-area-inset-top))', paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
    >
      <style>{`
        @keyframes vr-ticket-sheen {
          0%   { transform: translateX(-120%); }
          100% { transform: translateX(220%); }
        }
        .vr-ticket-sheen { animation: vr-ticket-sheen 3.6s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) { .vr-ticket-sheen { animation: none; } }
      `}</style>

      <motion.div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ethanol-ticket-title"
        onClick={(e) => e.stopPropagation()}
        initial={{ opacity: 0, y: 18, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.22, ease: 'easeOut' }}
        className="relative w-full max-w-[420px] max-h-[88vh] overflow-y-auto rounded-2xl"
        style={{
          background: 'linear-gradient(155deg, #fdf1c7 0%, #f4d67e 26%, #e0ae43 55%, #b8842a 85%, #8a601a 100%)',
          boxShadow: '0 24px 60px rgba(0,0,0,0.65), inset 0 1px 0 rgba(255,255,255,0.75)',
          border: '1px solid rgba(255,241,199,0.75)',
        }}
      >
        {/* metallic sheen sweep */}
        <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-2xl">
          <div
            className="vr-ticket-sheen absolute inset-y-0 w-1/3"
            style={{ background: 'linear-gradient(105deg, transparent, rgba(255,255,255,0.5), transparent)' }}
          />
        </div>

        {/* ticket perforation notches */}
        <div className="pointer-events-none absolute -left-2 top-1/2 h-4 w-4 -translate-y-1/2 rounded-full bg-black/80" />
        <div className="pointer-events-none absolute -right-2 top-1/2 h-4 w-4 -translate-y-1/2 rounded-full bg-black/80" />

        <button
          ref={closeRef}
          onClick={onDismiss}
          aria-label="Close"
          className="absolute right-2.5 top-2.5 z-10 rounded-full p-1.5 text-amber-950/70 hover:text-amber-950 hover:bg-black/10 transition-colors"
          style={{ touchAction: 'manipulation' }}
        >
          <X className="h-5 w-5" />
        </button>

        <div className="relative px-6 py-7 text-center">
          <div
            className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full"
            style={{ background: 'rgba(74,47,5,0.12)', border: '1px solid rgba(74,47,5,0.25)' }}
          >
            <FlaskConical className="h-6 w-6 text-amber-950" />
          </div>

          <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.25em] text-amber-950/60">
            Vroomie Premium Screening
          </p>

          <h2
            id="ethanol-ticket-title"
            className="mb-3 font-display text-2xl font-extrabold uppercase leading-[1.12] tracking-wide text-amber-950"
            style={{ textShadow: '0 1px 0 rgba(255,255,255,0.55)' }}
          >
            Ethanol<br />Contamination<br />Check
          </h2>

          <div
            className="mx-auto mb-4 h-px w-24"
            style={{ background: 'linear-gradient(90deg, transparent, rgba(74,47,5,0.45), transparent)' }}
          />

          <p className="mb-6 text-sm leading-relaxed text-amber-950/85">
            Check for possible ethanol-contamination-related mechanical indicators using
            Vroomie&apos;s existing AI-assisted engine sound analysis.
          </p>

          <button
            onClick={onCheckNow}
            className="mb-2.5 w-full rounded-xl px-5 py-3 text-sm font-extrabold uppercase tracking-wider text-amber-50 transition-transform active:scale-[0.98]"
            style={{
              background: 'linear-gradient(180deg, #3f2c07 0%, #241903 100%)',
              boxShadow: '0 4px 14px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.16)',
              touchAction: 'manipulation',
              minHeight: 44,
            }}
          >
            Check Now
          </button>

          <button
            onClick={onDismiss}
            className="w-full rounded-xl px-5 py-2.5 text-xs font-semibold uppercase tracking-wider text-amber-950/70 hover:text-amber-950 hover:bg-black/5 transition-colors"
            style={{ touchAction: 'manipulation', minHeight: 44 }}
          >
            Not now
          </button>
        </div>
      </motion.div>
    </div>
  );
}
