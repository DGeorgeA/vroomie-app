/**
 * AiDetectionAdminSetting — admin-only global control for AI Enabled detection.
 *
 * Rendered ONLY for users whose server-resolved role is 'admin'. Hiding it is
 * NOT the security boundary: the write goes to public.app_features, whose RLS
 * policy rejects any non-admin caller, so DOM or React-state tampering achieves
 * nothing.
 *
 * Switching this ON grants unlimited AI Enabled scans to EVERY user — free and
 * paid alike — bypassing the free-tier quota entirely. Switching it OFF returns
 * free users to their remaining allowance; paid subscribers are unaffected
 * either way because their entitlement comes from subscriber_base.plan_flag.
 *
 * Because the blast radius is every user, the change is confirmed first.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import { ShieldCheck, Sparkles, Loader2 } from 'lucide-react';
import { setFeatureEnabled } from '@/services/featureFlagService';
import {
  FEATURE_AI_DETECTION,
  FREE_AI_USE_LIMIT,
  isAiGloballyEnabled,
  invalidateAiAccessCache,
} from '@/services/aiAccessService';
import { useAuth } from '@/contexts/AuthContext';

export default function AiDetectionAdminSetting({ onChanged }) {
  const { isAdmin } = useAuth();
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    invalidateAiAccessCache();
    setEnabled(await isAiGloballyEnabled());
    setLoaded(true);
  }, []);

  useEffect(() => { if (isAdmin) load(); }, [isAdmin, load]);

  // Frontend visibility only. Backend RLS is the actual authorization.
  if (!isAdmin) return null;

  const handleToggle = async () => {
    const next = !enabled;
    const question = next
      ? 'Give every Vroomie user unlimited AI Enabled scans?'
      : `Switch AI Enabled back to subscription-only? Free users return to their remaining ${FREE_AI_USE_LIMIT}-scan allowance.`;
    if (!window.confirm(question)) return;

    setBusy(true);
    const res = await setFeatureEnabled(FEATURE_AI_DETECTION, next);
    setBusy(false);

    if (!res.ok) {
      toast.error(res.error || 'Could not update the setting.');
      return;
    }

    invalidateAiAccessCache();
    setEnabled(next);
    if (onChanged) await onChanged();
    toast.success(
      next
        ? 'AI Enabled detection is now available to all users.'
        : 'AI Enabled detection is back to paid subscribers and free trials.'
    );
  };

  return (
    <div className="mb-6 rounded-2xl border border-amber-500/20 bg-amber-500/[0.03] p-4">
      <div className="mb-3 flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-amber-400" />
        <h3 className="text-xs font-bold uppercase tracking-widest text-amber-400">
          Admin Settings · Detection Access
        </h3>
      </div>

      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-2">
            <Sparkles className="h-4 w-4 flex-shrink-0 text-zinc-300" />
            <p className="truncate text-sm font-semibold text-white">
              AI Enabled for everyone
            </p>
          </div>
          <p className="mb-2 text-xs text-zinc-400">
            When on, every user gets unlimited AI Enabled scans. When off, it stays
            unlimited for paid subscribers and capped at {FREE_AI_USE_LIMIT} scans
            on the free plan.
          </p>
          <span
            className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
              enabled
                ? 'border-emerald-500/30 bg-emerald-500/15 text-emerald-400'
                : 'border-zinc-700 bg-zinc-800/60 text-zinc-400'
            }`}
          >
            {!loaded ? 'Checking…' : enabled ? 'All users' : 'Subscribers only'}
          </span>
        </div>

        <button
          onClick={handleToggle}
          disabled={busy || !loaded}
          className={`flex-shrink-0 rounded-lg px-4 py-2.5 text-xs font-bold uppercase tracking-wider transition-colors disabled:opacity-60 ${
            enabled
              ? 'border border-red-500/30 bg-red-500/10 text-red-300 hover:bg-red-500/20'
              : 'bg-white text-black hover:bg-zinc-200'
          }`}
          style={{ touchAction: 'manipulation', minHeight: 44 }}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : enabled ? 'Disable' : 'Enable'}
        </button>
      </div>
    </div>
  );
}
