/**
 * aiAccessService.js — who may use the "AI Enabled" detection mode (Path B).
 *
 * Backed by public.subscriber_base (plan_flag, is_admin, ai_enabled_uses) and
 * the global public.app_features flag 'ai_enabled_detection'. See
 * ai_detection_setup.sql for the schema, the privileged-column guard and the
 * SECURITY DEFINER counter.
 *
 * PRECEDENCE — first match wins:
 *   1. Admin                         -> unlimited
 *   2. Global unlock flag is ON      -> unlimited (admin switched it on for all)
 *   3. Paid subscriber (plan_flag P) -> unlimited
 *   4. Free (plan_flag F)            -> FREE_AI_USE_LIMIT scans, then blocked
 *
 * FAIL-SAFE: any error, missing row, missing session or offline device resolves
 * to the FREE tier with zero uses consumed — never to unlimited. A billing
 * lookup failing must not hand out paid functionality, and must not break
 * Basic mode, which never consults this module at all.
 */
import { supabase } from '@/lib/supabase';
import { Logger } from '@/lib/logger';
import { isFeatureEnabled, invalidateFeatureCache } from './featureFlagService';

/** Global admin switch that unlocks AI Enabled for every user. */
export const FEATURE_AI_DETECTION = 'ai_enabled_detection';

/** Lifetime AI Enabled scans allowed on the free plan. */
export const FREE_AI_USE_LIMIT = 10;

/** Why access was granted — drives the wording the UI shows. */
export const GRANT_ADMIN  = 'admin';
export const GRANT_GLOBAL = 'global';
export const GRANT_PAID   = 'paid';
export const GRANT_FREE   = 'free';
export const GRANT_NONE   = 'none';

/**
 * Shape returned by getAiAccess(). `allowed` is the only field the gate should
 * branch on; the rest is presentation.
 * @typedef  {Object} AiAccess
 * @property {boolean} allowed     may the user start an AI Enabled scan now
 * @property {boolean} unlimited   true when no quota applies
 * @property {string}  grant       one of GRANT_*
 * @property {number}  used        AI Enabled scans already consumed
 * @property {number}  limit       quota ceiling (Infinity when unlimited)
 * @property {number}  remaining   scans left (Infinity when unlimited)
 * @property {boolean} isAdmin
 * @property {boolean} isPaid
 */

const FREE_DENIED = Object.freeze({
  allowed: false, unlimited: false, grant: GRANT_NONE,
  used: FREE_AI_USE_LIMIT, limit: FREE_AI_USE_LIMIT, remaining: 0,
  isAdmin: false, isPaid: false,
});

/** Fail-safe result: signed out, offline, or the lookup threw. */
function lockedOut(grant = GRANT_NONE) {
  return { ...FREE_DENIED, grant };
}

/**
 * Resolve the caller's current AI Enabled entitlement.
 * @param {string|null} userId authenticated Auth UUID
 * @returns {Promise<AiAccess>}
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

  const isAdmin = row?.is_admin === true;
  const isPaid  = row?.plan_flag === 'P';
  const used    = Number.isFinite(row?.ai_enabled_uses) ? row.ai_enabled_uses : 0;

  // 1. Admin — full access, always.
  if (isAdmin) {
    return {
      allowed: true, unlimited: true, grant: GRANT_ADMIN,
      used, limit: Infinity, remaining: Infinity, isAdmin: true, isPaid,
    };
  }

  // 2. Global unlock — the admin turned AI Enabled on for everyone.
  //    isFeatureEnabled is itself fail-safe (false on any error).
  const globallyOn = await isFeatureEnabled(FEATURE_AI_DETECTION);
  if (globallyOn) {
    return {
      allowed: true, unlimited: true, grant: GRANT_GLOBAL,
      used, limit: Infinity, remaining: Infinity, isAdmin: false, isPaid,
    };
  }

  // 3. Paid subscriber — unlimited.
  if (isPaid) {
    return {
      allowed: true, unlimited: true, grant: GRANT_PAID,
      used, limit: Infinity, remaining: Infinity, isAdmin: false, isPaid: true,
    };
  }

  // 4. Free tier — capped.
  const remaining = Math.max(0, FREE_AI_USE_LIMIT - used);
  return {
    allowed: remaining > 0,
    unlimited: false,
    grant: remaining > 0 ? GRANT_FREE : GRANT_NONE,
    used,
    limit: FREE_AI_USE_LIMIT,
    remaining,
    isAdmin: false,
    isPaid: false,
  };
}

/**
 * Record one AI Enabled scan against the free-tier quota.
 *
 * Only free users consume; admins, globally-unlocked and paid users are
 * no-ops so the counter stays a meaningful measure of free-trial usage.
 * The increment goes through a SECURITY DEFINER function because the column
 * is deliberately not client-writable.
 *
 * @param {AiAccess} access the entitlement resolved immediately beforehand
 * @returns {Promise<AiAccess|null>} refreshed entitlement, or null if unchanged
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
    const remaining = Math.max(0, FREE_AI_USE_LIMIT - used);

    return {
      ...access,
      used,
      remaining,
      allowed: remaining > 0,
      grant: remaining > 0 ? GRANT_FREE : GRANT_NONE,
    };
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

/**
 * Human-readable entitlement line for Settings / the toggle tooltip.
 * @param {AiAccess} a
 * @returns {string}
 */
export function describeAiAccess(a) {
  if (!a) return 'Sign in to use AI Enabled detection';
  switch (a.grant) {
    case GRANT_ADMIN:  return 'Administrator — unlimited AI Enabled scans';
    case GRANT_GLOBAL: return 'AI Enabled is switched on for everyone';
    case GRANT_PAID:   return 'Pro subscription — unlimited AI Enabled scans';
    case GRANT_FREE:   return `Free plan — ${a.remaining} of ${a.limit} AI Enabled scans left`;
    default:           return `Free trial used up — all ${a.limit} AI Enabled scans spent`;
  }
}
