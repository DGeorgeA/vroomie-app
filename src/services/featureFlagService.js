/**
 * featureFlagService.js — global, admin-controlled feature flags.
 *
 * Backed by public.app_features (see ethanol_feature_setup.sql). Reads are open
 * to every session so the UI can render; writes are rejected by RLS unless the
 * caller holds the 'admin' role. The frontend NEVER decides authorization — it
 * only reflects what the server allows.
 *
 * FAIL-SAFE: if the table is missing, the network is down, or anything throws,
 * every flag resolves to FALSE. An optional feature must never be able to break
 * core Vroomie (health check, recording, reports, navigation).
 */
import { supabase } from '@/lib/supabase';
import { Logger } from '@/lib/logger';

export const FEATURE_ETHANOL_CHECK = 'ethanol_contamination_check';

// Short in-memory cache — avoids re-querying on every render without polling.
const CACHE_TTL_MS = 60_000;
let _cache = { value: null, at: 0 };

/** Drop the cache so the next read hits the server (used after an admin write). */
export function invalidateFeatureCache() {
  _cache = { value: null, at: 0 };
}

/**
 * @returns {Promise<Record<string, boolean>>} effective flag state; {} on failure.
 */
export async function getFeatureFlags() {
  const now = Date.now();
  if (_cache.value && now - _cache.at < CACHE_TTL_MS) return _cache.value;

  try {
    const { data, error } = await supabase
      .from('app_features')
      .select('feature_key, enabled');

    if (error) {
      Logger.warn('Feature flags unavailable — defaulting all to OFF:', error.message);
      return {};
    }

    const flags = {};
    for (const row of data || []) flags[row.feature_key] = row.enabled === true;
    _cache = { value: flags, at: now };
    return flags;
  } catch (err) {
    Logger.warn('Feature flag lookup threw — defaulting all to OFF:', err?.message);
    return {};
  }
}

/**
 * @param {string} key
 * @returns {Promise<boolean>} false on any failure (fail-safe).
 */
export async function isFeatureEnabled(key) {
  const flags = await getFeatureFlags();
  return flags[key] === true;
}

/**
 * Admin-only write. Authorization is enforced by RLS server-side — a normal
 * user calling this gets a database error, not a state change.
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function setFeatureEnabled(key, enabled) {
  try {
    const { data, error } = await supabase
      .from('app_features')
      .update({ enabled })
      .eq('feature_key', key)
      .select();

    if (error) {
      Logger.error('Feature flag update rejected:', error.message);
      return { ok: false, error: error.message };
    }
    // RLS returns an empty set (no error) when the row is invisible/not writable.
    if (!data || data.length === 0) {
      return { ok: false, error: 'Not authorized to change this setting.' };
    }

    invalidateFeatureCache();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || 'Update failed' };
  }
}
