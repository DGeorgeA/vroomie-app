/**
 * EthanolAdminSetting — admin-only global control for the Ethanol
 * Contamination Check.
 *
 * Rendered ONLY for users whose server-resolved role is 'admin'. Normal users
 * never see it — and, critically, hiding it is not the security boundary: the
 * write is rejected by Supabase RLS for anyone who is not an admin, so DOM or
 * React-state tampering achieves nothing.
 *
 * Toggling requires confirmation because the change is global (all users).
 */
import React, { useState } from 'react';
import { toast } from 'sonner';
import { ShieldCheck, FlaskConical, Loader2 } from 'lucide-react';
import { setFeatureEnabled, FEATURE_ETHANOL_CHECK } from '@/services/featureFlagService';
import { useEthanolFeature } from '@/contexts/EthanolFeatureContext';
import { useAuth } from '@/contexts/AuthContext';

export default function EthanolAdminSetting() {
  const { isAdmin } = useAuth();
  const { enabled, refresh } = useEthanolFeature();
  const [busy, setBusy] = useState(false);

  // Frontend visibility only. Backend RLS is the actual authorization.
  if (!isAdmin) return null;

  const handleToggle = async () => {
    const next = !enabled;
    const question = next
      ? 'Enable Ethanol Contamination Check for all users?'
      : 'Disable Ethanol Contamination Check for all users?';
    if (!window.confirm(question)) return;

    setBusy(true);
    const res = await setFeatureEnabled(FEATURE_ETHANOL_CHECK, next);
    setBusy(false);

    if (!res.ok) {
      toast.error(res.error || 'Could not update the feature.');
      return;
    }
    await refresh();
    toast.success(`Ethanol Contamination Check ${next ? 'enabled' : 'disabled'} for all users.`);
  };

  return (
    <div className="mb-6 rounded-2xl border border-amber-500/20 bg-amber-500/[0.03] p-4">
      <div className="mb-3 flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-amber-400" />
        <h3 className="text-xs font-bold uppercase tracking-widest text-amber-400">
          Admin Settings · Special Features
        </h3>
      </div>

      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-2">
            <FlaskConical className="h-4 w-4 flex-shrink-0 text-zinc-300" />
            <p className="truncate text-sm font-semibold text-white">Ethanol Contamination Check</p>
          </div>
          <p className="mb-2 text-xs text-zinc-400">
            Enable or disable the Ethanol Contamination Check for all Vroomie users.
          </p>
          <span
            className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
              enabled
                ? 'border-emerald-500/30 bg-emerald-500/15 text-emerald-400'
                : 'border-zinc-700 bg-zinc-800/60 text-zinc-400'
            }`}
          >
            {enabled ? 'Active' : 'Inactive'}
          </span>
        </div>

        <button
          onClick={handleToggle}
          disabled={busy}
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
