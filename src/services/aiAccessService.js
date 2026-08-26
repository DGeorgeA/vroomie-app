/**
 * aiAccessService.js — I/O for the AI Enabled (Path B) entitlement.
 *
 * Fetches the caller's subscriber_base row and the global unlock flag, then
 * hands both to aiAccessPolicy.js, which owns the precedence rules. Splitting
 * them keeps the decision testable without a database: see
 * scripts/qa_ai_enabled.mjs, which exercises the policy directly.
 *
 * Backed by public.subscriber_base (plan_flag, is_admin, ai_enabled_uses) and
 * the global public.app_features flag 'ai_enabled_detection'. See
 * ai_detection_setup.sql for the schema, the privileged-column guard and the
 * SECURITY DEFINER counter.
 *
 * FAIL-SAFE: any error, missing row, missing session or offline device resolves
 * to lockedOut() — never to unlimited. A billing lookup failing must not hand
 * out paid functionality, and must not break Basic mode, which never consults
 * this module at all.
 */
import { supabase } from '@/lib/supabase';
import { Logger } from '@/lib/logger';
import { isFeatureEnabled, invalidateFeatureCache } from './featureFlagService';
import {
  resolveAiAccess,
  applyConsumedUse,
  lockedOut,
  describeAiAccess,
  FEATURE_AI_DETECTION,
  FREE_AI_USE_LIMIT,
  GRANT_ADMIN,
  GRANT_GLOBAL,
  GRANT_PAID,
  GRANT_FREE,
  GRANT_NONE,
} from './aiAccessPolicy';

// Re-exported so callers keep importing entitlement symbols from one place.
export {
  describeAiAccess,
  FEATURE_AI_DETECTION,
  FREE_AI_USE_LIMIT,
  GRANT_ADMIN,
  GRANT_GLOBAL,
  GRANT_PAID,
  GRANT_FREE,
  GRANT_NONE,
};

/**
 * Resolve the caller's current AI Enabled entitlement.
 * @param {string|null} userId authenticated Auth UUID
 * @returns {Promise<import('./aiAccessPolicy').AiAccess>}
 */
export async function getAiAccess(userId) {
  if (!userId) return lockedOut();

  let row = null;
  try {
    const { data, error } = await supabase
      .from('subscriber_base')
      .select('plan_flag, is_admin, ai_enabled_uses')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      Logger.warn('AI access lookup failed — defaulting to locked:', error.message);
      return lockedOut();
    }
    row = data;
  } catch (err) {
    Logger.warn('AI access lookup threw — defaulting to locked:', err?.message);
    return lockedOut();
  }

  // isFeatureEnabled is itself fail-safe (false on any error), so a flag
  // outage can only ever withhold the global unlock, never grant it.
  const globallyOn = await isFeatureEnabled(FEATURE_AI_DETECTION);
  return resolveAiAccess(row, globallyOn);
}

/**
 * Record one AI Enabled scan against the free-tier quota.
 *
 * Only free users consume; admins, globally-unlocked and paid users are no-ops
 * so the counter stays a meaningful measure of free-trial usage. The increment
 * goes through a SECURITY DEFINER function because the column is deliberately
 * not client-writable.
 *
 * @param {import('./aiAccessPolicy').AiAccess} access entitlement resolved immediately beforehand
 * @returns {Promise<import('./aiAccessPolicy').AiAccess|null>} refreshed entitlement, or null if unchanged
 */
export async function consumeAiUse(access) {
  if (!access || access.unlimited) return null;

  try {
    const { data, error } = await supabase.rpc('consume_ai_use');
    if (error) {
      Logger.warn('AI use counter not incremented:', error.message);
      return null;
    }

    const rec = Array.isArray(data) ? data[0] : data;
    const used = Number.isFinite(rec?.uses) ? rec.uses : access.used + 1;
    return applyConsumedUse(access, used);
  } catch (err) {
    Logger.warn('AI use counter threw:', err?.message);
    return null;
  }
}

/**
 * Read the global unlock flag (admin UI reflects the live value).
 * @returns {Promise<boolean>}
 */
export async function isAiGloballyEnabled() {
  return isFeatureEnabled(FEATURE_AI_DETECTION);
}

/** Drop the cached flag value so the next read hits the server. */
export function invalidateAiAccessCache() {
  invalidateFeatureCache();
}
