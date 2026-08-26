/**
 * aiAccessPolicy.js — the AI Enabled (Path B) entitlement DECISION, with no I/O.
 *
 * Kept free of Supabase and of every other import so the precedence rules can be
 * executed directly by scripts/qa_ai_enabled.mjs. aiAccessService.js owns the
 * fetching; this module owns what the fetched values mean.
 *
 * PRECEDENCE — first match wins:
 *   1. Admin                         -> unlimited
 *   2. Global unlock flag is ON      -> unlimited (admin switched it on for all)
 *   3. Paid subscriber (plan_flag P) -> unlimited
 *   4. Free (plan_flag F)            -> FREE_AI_USE_LIMIT scans, then blocked
 *
 * FAIL-SAFE: a null/absent row resolves to locked out, never to unlimited.
 */

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

/**
 * Fail-safe result: signed out, offline, or the lookup threw.
 * Deliberately reports the quota as fully spent so no caller can mistake a
 * failure for an entitlement.
 * @returns {AiAccess}
 */
export function lockedOut(grant = GRANT_NONE) {
  return {
    allowed: false, unlimited: false, grant,
    used: FREE_AI_USE_LIMIT, limit: FREE_AI_USE_LIMIT, remaining: 0,
    isAdmin: false, isPaid: false,
  };
}

/**
 * Apply the precedence rules to an already-fetched subscriber row.
 *
 * @param {{plan_flag?: string, is_admin?: boolean, ai_enabled_uses?: number}|null} row
 *        subscriber_base row, or null when it is missing/unreadable
 * @param {boolean} globallyOn value of the 'ai_enabled_detection' feature flag
 * @returns {AiAccess}
 */
export function resolveAiAccess(row, globallyOn) {
  if (!row) return lockedOut();

  const isAdmin = row.is_admin === true;
  const isPaid  = row.plan_flag === 'P';
  // A missing, non-numeric or negative counter is treated as zero used — the
  // quota branch below still bounds it, so this cannot leak unlimited access.
  const rawUses = row.ai_enabled_uses;
  const used    = Number.isFinite(rawUses) && rawUses > 0 ? Math.floor(rawUses) : 0;

  // 1. Admin — full access, always.
  if (isAdmin) {
    return {
      allowed: true, unlimited: true, grant: GRANT_ADMIN,
      used, limit: Infinity, remaining: Infinity, isAdmin: true, isPaid,
    };
  }

  // 2. Global unlock — the admin turned AI Enabled on for everyone.
  if (globallyOn === true) {
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
 * Recompute entitlement after the counter has been incremented server-side.
 * @param {AiAccess} access entitlement before the scan
 * @param {number} used authoritative new counter value from consume_ai_use()
 * @returns {AiAccess}
 */
export function applyConsumedUse(access, used) {
  const remaining = Math.max(0, FREE_AI_USE_LIMIT - used);
  return {
    ...access,
    used,
    remaining,
    allowed: remaining > 0,
    grant: remaining > 0 ? GRANT_FREE : GRANT_NONE,
  };
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
