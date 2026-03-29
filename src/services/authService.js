import { supabase } from '../lib/supabase';
import { Logger } from '../lib/logger';

/**
 * Auth Service — Supabase Email/Password Authentication
 * 
 * IMPORTANT: Signup does NOT touch subscriber_base. 
 * The subscriber record is created lazily by ensureSubscriberRecord()
 * after successful auth. This prevents "Database error saving new user"
 * when the table doesn't exist or RLS blocks during the auth flow.
 */

export async function signUp(email, password) {
  try {
    const { data, error } = await supabase.auth.signUp({ email, password });
    
    if (error) {
      Logger.error('Sign up failed', error);
      throw new Error(error.message || 'Sign up failed. Please try again.');
    }
    
    // After successful auth signup, lazily create subscriber record
    if (data.user) {
      await ensureSubscriberRecord(data.user.id, data.user.email);
    }
    
    return data;
  } catch (err) {
    // Catch any unexpected errors so the app never crashes
    Logger.error('signUp exception', err);
    throw err;
  }
}

export async function signIn(email, password) {
  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    
    if (error) {
      Logger.error('Sign in failed', error);
      throw new Error(error.message || 'Sign in failed. Check your credentials.');
    }
    
    // Ensure subscriber record exists on login too (handles legacy users)
    if (data.user) {
      await ensureSubscriberRecord(data.user.id, data.user.email);
    }
    
    Logger.info(`Signed in: ${email}`);
    return data;
  } catch (err) {
    Logger.error('signIn exception', err);
    throw err;
  }
}

/**
 * Lazily ensures a subscriber_base record exists for the user.
 * If the table doesn't exist or RLS blocks, this fails silently
 * and the user simply gets FREE mode (graceful degradation).
 */
export async function ensureSubscriberRecord(userId, email) {
  try {
    // Check if record already exists
    const { data: existing, error: selectError } = await supabase
      .from('subscriber_base')
      .select('id')
      .eq('user_id', userId)
      .maybeSingle();
    
    if (selectError) {
      // Table might not exist — fail silently, user gets FREE mode
      Logger.warn('subscriber_base read failed (table may not exist)', selectError.message);
      return null;
    }
    
    if (existing) {
      Logger.debug('subscriber_base record already exists');
      return existing;
    }
    
    // Create new record
    const { data: inserted, error: insertError } = await supabase
      .from('subscriber_base')
      .insert({
        user_id: userId,
        email: email,
        plan: 'free',
        subscription_status: 'inactive',
        expiry_date: null
      })
      .select()
      .single();
    
    if (insertError) {
      Logger.warn('subscriber_base insert failed', insertError.message);
      return null;
    }
    
    Logger.info(`subscriber_base created for ${email} (free plan)`);
    return inserted;
  } catch (err) {
    // Never crash the app — just default to free
    Logger.warn('ensureSubscriberRecord failed silently', err);
    return null;
  }
}

export async function signOut() {
  try {
    const { error } = await supabase.auth.signOut();
    if (error) {
      Logger.error('Sign out failed', error);
      throw error;
    }
    Logger.info('Signed out');
  } catch (err) {
    Logger.error('signOut exception', err);
    // Force local cleanup even if server fails
  }
}

export async function getCurrentUser() {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    return user;
  } catch (err) {
    Logger.warn('getCurrentUser failed', err);
    return null;
  }
}

export async function getSession() {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    return session;
  } catch (err) {
    Logger.warn('getSession failed', err);
    return null;
  }
}

export function onAuthStateChange(callback) {
  return supabase.auth.onAuthStateChange((event, session) => {
    callback(event, session);
  });
}
