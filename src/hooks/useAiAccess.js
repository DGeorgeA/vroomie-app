/**
 * useAiAccess — React binding for the AI Enabled (Path B) entitlement.
 *
 * Resolves who may run AI Enabled detection and how much of the free-tier
 * quota is left, refreshing whenever the signed-in user changes. Consumers get
 * a stable object plus two actions:
 *   refresh() — re-read entitlement (after an upgrade or an admin toggle)
 *   consume() — record one AI Enabled scan against the free quota
 *
 * The hook never blocks rendering: it starts locked out and opens up once the
 * server answers, so a slow or failed lookup can only ever be more restrictive.
 * Basic mode does not use this hook and is unaffected by anything here.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { getAiAccess, consumeAiUse } from '@/services/aiAccessService';
import { FREE_AI_USE_LIMIT, GRANT_NONE } from '@/services/aiAccessPolicy';

const INITIAL = Object.freeze({
  allowed: false, unlimited: false, grant: GRANT_NONE,
  used: 0, limit: FREE_AI_USE_LIMIT, remaining: 0,
  isAdmin: false, isPaid: false,
});

export function useAiAccess() {
  const { user, isPro } = useAuth();
  const [access, setAccess] = useState(INITIAL);
  const [loading, setLoading] = useState(true);
  // Guards against a slow response for a previous user overwriting a newer one.
  const requestIdRef = useRef(0);

  const refresh = useCallback(async () => {
    const id = ++requestIdRef.current;
    setLoading(true);
    const next = await getAiAccess(user?.id || null);
    if (id === requestIdRef.current) {
      setAccess(next);
      setLoading(false);
    }
    return next;
  }, [user?.id]);

  // Re-resolve on sign-in/sign-out and whenever the subscription changes
  // (AuthContext.refreshSubscription flips isPro after a successful payment).
  useEffect(() => { refresh(); }, [refresh, isPro]);

  /**
   * Record one AI Enabled scan. Safe to call for unlimited users — it is a
   * no-op for them and returns the unchanged entitlement.
   * @returns {Promise<import('@/services/aiAccessService').AiAccess>}
   */
  const consume = useCallback(async () => {
    const updated = await consumeAiUse(access);
    if (updated) {
      setAccess(updated);
      return updated;
    }
    return access;
  }, [access]);

  return { ...access, loading, refresh, consume };
}

export default useAiAccess;
