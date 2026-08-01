/**
 * roleService.js — server-authoritative role lookup.
 *
 * The role is read from public.user_roles, keyed by the authenticated Auth UUID.
 * It is NEVER derived from an email comparison, localStorage, a query string, or
 * any other client-controlled value — those can all be forged. The email in
 * ethanol_feature_setup.sql is used once, server-side, to decide WHICH account
 * receives the admin role; from then on the UUID is the identity.
 *
 * FAIL CLOSED: any error, missing row, or missing session resolves to 'user'.
 * There is no code path in this module that can return 'admin' without the
 * database saying so.
 */
import { supabase } from '@/lib/supabase';
import { Logger } from '@/lib/logger';

export const ROLE_ADMIN = 'admin';
export const ROLE_USER = 'user';

/**
 * @param {string|null} userId authenticated Auth UUID
 * @returns {Promise<'admin'|'user'>} 'user' on any failure.
 */
export async function getUserRole(userId) {
  if (!userId) return ROLE_USER;

  try {
    const { data, error } = await supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      Logger.warn('Role lookup failed — defaulting to user:', error.message);
      return ROLE_USER;
    }
    return data?.role === ROLE_ADMIN ? ROLE_ADMIN : ROLE_USER;
  } catch (err) {
    Logger.warn('Role lookup threw — defaulting to user:', err?.message);
    return ROLE_USER;
  }
}

/** Convenience predicate. Frontend visibility only — never authorization. */
export async function checkIsAdmin(userId) {
  return (await getUserRole(userId)) === ROLE_ADMIN;
}
