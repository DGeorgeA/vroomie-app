/**
 * EthanolResultModal — renders the outcome of the Ethanol Contamination Check.
 *
 * Presents ONLY what the existing anomaly engine already found. It never claims
 * ethanol contamination was detected, and never issues a clean bill of health.
 */
import React, { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { X, AlertTriangle, CheckCircle2, Wrench, Info, FileText } from 'lucide-react';
import { buildEthanolScreeningCopy } from '@/lib/ethanolScreening';

export default function EthanolResultModal({ open, result, onClose, onViewReport }) {
  const closeRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    closeRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open || !result) return null;
  const copy = buildEthanolScreeningCopy(result);
  const positive = result.hasIndicators;

  return (
    <div
      className="fixed inset-0 z-[1100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
      style={{ paddingTop: 'max(1rem, env(safe-area-inset-top))', paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-labelledby="ethanol-result-title"
        onClick={(e) => e.stopPropagation()}
        initial={{ opacity: 0, y: 18, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.22, ease: 'easeOut' }}
        className="relative w-full max-w-[460px] max-h-[88vh] overflow-y-auto rounded-2xl border border-white/10 bg-zinc-950 shadow-2xl"
      >
        <button
          ref={closeRef}
          onClick={onClose}
          aria-label="Close"
          className="absolute right-3 top-3 z-10 rounded-lg p-2 text-zinc-400 hover:bg-white/5 hover:text-white transition-colors"
          style={{ touchAction: 'manipulation' }}
        >
          <X className="h-5 w-5" />
        </button>

        <div className="px-6 pt-6 pb-5">
          <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.22em] text-amber-400/80">
            Ethanol Contamination Check
          </p>

          <div className="mb-4 flex items-start gap-2.5">
            {positive
              ? <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-400" />
              : <CheckCircle2 className="mt-0.5 h-5 w-5 flex-shrink-0 text-emerald-400" />}
            <h2 id="ethanol-result-title" className="text-lg font-bold leading-snug text-white">
              {copy.heading}
            </h2>
          </div>

          {positive && (
            <div className="mb-4 rounded-xl border border-amber-500/25 bg-amber-500/5 p-3.5">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-amber-300/90">
                {copy.lead}
              </p>
              <ul className="space-y-1.5">
                {result.indicators.map((ind) => (
                  <li key={ind.faultType} className="flex items-center gap-2 text-sm text-white">
                    <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-amber-400" />
                    {ind.type}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <p className="mb-4 text-sm leading-relaxed text-zinc-300">{copy.explanation}</p>

          <div className={`mb-4 rounded-xl border p-3.5 ${positive ? 'border-emerald-500/25 bg-emerald-500/5' : 'border-white/10 bg-white/5'}`}>
            <div className="mb-1.5 flex items-center gap-1.5">
              <Wrench className="h-3.5 w-3.5 flex-shrink-0 text-emerald-400" />
              <span className="text-xs font-semibold uppercase tracking-wide text-emerald-400">
                {positive ? 'Recommended next step' : 'Please note'}
              </span>
            </div>
            <p className="text-sm leading-relaxed text-zinc-200">{copy.recommendation}</p>
            {copy.recommendationDetail && (
              <p className="mt-2 text-xs leading-relaxed text-zinc-400">{copy.recommendationDetail}</p>
            )}
          </div>

          {/* Disclaimer — visible and readable, never buried in T&Cs */}
          <div className="mb-5 flex gap-2 rounded-lg border border-white/5 bg-black/40 p-3">
            <Info className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-zinc-500" />
            <p className="text-[11px] leading-relaxed text-zinc-500">{copy.disclaimer}</p>
          </div>

          {onViewReport && (
            <button
              onClick={onViewReport}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-white px-5 py-3 text-sm font-bold text-black transition-colors hover:bg-zinc-200"
              style={{ touchAction: 'manipulation', minHeight: 44 }}
            >
              <FileText className="h-4 w-4" />
              View Vroomie Report
            </button>
          )}
        </div>
      </motion.div>
    </div>
  );
}
