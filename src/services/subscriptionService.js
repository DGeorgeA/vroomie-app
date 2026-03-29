import { supabase } from '../lib/supabase';
import { Logger } from '../lib/logger';

/**
 * Subscription Service — Plan management & UPI payment
 */

const PLANS = {
  monthly: {
    id: 'monthly',
    name: 'Monthly Pro',
    price: 100,
    currency: 'INR',
    durationDays: 30,
    label: '₹100/month'
  },
  yearly: {
    id: 'yearly',
    name: 'Yearly Pro',
    price: 700,
    currency: 'INR',
    durationDays: 365,
    label: '₹700/year'
  }
};

export { PLANS };

/**
 * Get subscription record for user
 */
export async function getSubscription(userId) {
  try {
    const { data, error } = await supabase
      .from('subscriber_base')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();
    
    if (error) {
      Logger.warn('Subscription fetch failed (table may not exist)', error.message);
      return null;
    }
    return data;
  } catch (err) {
    Logger.warn('getSubscription exception — defaulting to free', err);
    return null;
  }
}

/**
 * Check if user has active pro subscription
 */
export async function isProUser(userId) {
  if (!userId) return false;
  
  const sub = await getSubscription(userId);
  if (!sub) return false;
  
  const isActive = sub.subscription_status === 'active';
  const notExpired = sub.expiry_date && new Date(sub.expiry_date) > new Date();
  
  if (isActive && !notExpired) {
    // Auto-expire
    await supabase
      .from('subscriber_base')
      .update({ subscription_status: 'inactive' })
      .eq('user_id', userId);
    Logger.info('Subscription expired, reverted to free');
    return false;
  }
  
  return isActive && notExpired;
}

/**
 * Activate subscription after payment verification
 */
export async function activateSubscription(userId, planId) {
  const plan = PLANS[planId];
  if (!plan) throw new Error(`Unknown plan: ${planId}`);
  
  const expiry = new Date();
  expiry.setDate(expiry.getDate() + plan.durationDays);
  
  const { error } = await supabase
    .from('subscriber_base')
    .update({
      plan: 'pro',
      subscription_status: 'active',
      expiry_date: expiry.toISOString()
    })
    .eq('user_id', userId);
  
  if (error) {
    Logger.error('Subscription activation failed', error);
    throw error;
  }
  
  Logger.info(`Subscription activated: ${plan.name}, expires ${expiry.toLocaleDateString()}`);
  return { plan: plan.name, expiry };
}

/**
 * Start 3-Day Free Trial
 */
export async function startFreeTrial(userId) {
  const expiry = new Date();
  expiry.setDate(expiry.getDate() + 3);
  
  const { error } = await supabase
    .from('subscriber_base')
    .update({
      plan: 'pro',
      subscription_status: 'active',
      expiry_date: expiry.toISOString()
    })
    .eq('user_id', userId);
    
  if (error) {
    Logger.error('Trial activation failed', error);
    throw error;
  }
  
  Logger.info(`3-Day Free Trial activated, expires ${expiry.toLocaleDateString()}`);
  return { plan: '3-Day Trial', expiry };
}

/**
 * Generate UPI payment intent link
 */
export function generateUPILink(planId, merchantUPI = 'vroomieride@okaxis') {
  const plan = PLANS[planId];
  if (!plan) return null;
  
  const params = new URLSearchParams({
    pa: merchantUPI,
    pn: 'VroomieRide',
    am: plan.price.toString(),
    cu: plan.currency,
    tn: `Vroomie ${plan.name} Subscription`
  });
  
  return `upi://pay?${params.toString()}`;
}

/**
 * Generate GPay web link (fallback for desktop)
 */
export function generateGPayLink(planId, merchantUPI = 'vroomieride@okaxis') {
  const plan = PLANS[planId];
  if (!plan) return null;
  
  return `https://pay.google.com/gp/v/save/${encodeURIComponent(
    `upi://pay?pa=${merchantUPI}&pn=VroomieRide&am=${plan.price}&cu=${plan.currency}`
  )}`;
}
