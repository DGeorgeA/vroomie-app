/**
 * paymentService.js — Razorpay-ready monetization pipeline
 *
 * Environment variables required (add to .env):
 *   VITE_RAZORPAY_KEY_ID=       ← public key (safe for client)
 *
 * Server-side only (NEVER in frontend .env):
 *   RAZORPAY_SECRET=
 *   RAZORPAY_WEBHOOK_SECRET=
 */

import { supabase } from '@/lib/supabase';
import { Logger } from '@/lib/logger';

// ── Constants ──────────────────────────────────────────────────────────────────

export const RAZORPAY_KEY_ID = import.meta.env.VITE_RAZORPAY_KEY_ID || '';

export const SUBSCRIPTION_PLANS = {
  FREE: {
    id: 'FREE',
    name: 'Free',
    price: 0,
    currency: 'INR',
    apiCallsPerDay: 100,
    apiCallsPerMonth: 1000,
    rpmLimit: 10,
    features: ['Basic anomaly detection', '1,000 API calls/month', 'Community support'],
  },
  AI_ENABLED_MONTHLY: {
    id: 'AI_ENABLED_MONTHLY',
    name: 'AI Enabled — Monthly',
    price: 100,
    currency: 'INR',
    durationDays: 30,
    apiCallsPerDay: 5000,
    apiCallsPerMonth: 50000,
    rpmLimit: 60,
    features: ['AI/ML detection engine', '50,000 API calls/month', 'Priority support', 'Advanced reports'],
  },
  AI_ENABLED_YEARLY: {
    id: 'AI_ENABLED_YEARLY',
    name: 'AI Enabled — Yearly',
    price: 700,
    currency: 'INR',
    durationDays: 365,
    apiCallsPerDay: 5000,
    apiCallsPerMonth: 50000,
    rpmLimit: 60,
    features: ['AI/ML detection engine', '50,000 API calls/month', 'Priority support', 'Advanced reports', 'Save 42%'],
  },
};

// ── Load Razorpay SDK (lazy) ───────────────────────────────────────────────────

let _rzpScriptLoaded = false;

async function loadRazorpaySDK() {
  if (_rzpScriptLoaded || window.Razorpay) {
    _rzpScriptLoaded = true;
    return true;
  }
  return new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.async = true;
    script.onload = () => { _rzpScriptLoaded = true; resolve(true); };
    script.onerror = () => resolve(false);
    document.head.appendChild(script);
  });
}

// ── Order creation (calls your backend / Supabase Edge Function) ──────────────

export async function createRazorpayOrder({ planId, userId, userEmail }) {
  const plan = SUBSCRIPTION_PLANS[planId];
  if (!plan || plan.price === 0) throw new Error('Invalid paid plan');

  // Call Supabase Edge Function (deploy separately — see docs/edge-functions)
  const { data, error } = await supabase.functions.invoke('create-razorpay-order', {
    body: {
      planId,
      amount: plan.price * 100, // Razorpay expects paise
      currency: plan.currency,
      userId,
      receipt: `vrm_${userId?.slice(0, 8)}_${Date.now()}`,
    },
  });

  if (error) {
    Logger.error('Razorpay order creation failed', error);
    throw new Error(error.message || 'Order creation failed');
  }
  return data; // { orderId, amount, currency }
}

// ── Open Razorpay checkout ────────────────────────────────────────────────────

export async function openRazorpayCheckout({ planId, userId, userEmail, onSuccess, onFailure }) {
  const sdkReady = await loadRazorpaySDK();
  if (!sdkReady || !window.Razorpay) {
    const msg = 'Razorpay SDK could not be loaded. Check your internet connection.';
    Logger.error(msg);
    onFailure?.(new Error(msg));
    return;
  }

  if (!RAZORPAY_KEY_ID) {
    const msg = 'VITE_RAZORPAY_KEY_ID is not configured.';
    Logger.error(msg);
    onFailure?.(new Error(msg));
    return;
  }

  let orderData;
  try {
    orderData = await createRazorpayOrder({ planId, userId, userEmail });
  } catch (err) {
    onFailure?.(err);
    return;
  }

  const plan = SUBSCRIPTION_PLANS[planId];

  const options = {
    key: RAZORPAY_KEY_ID,
    amount: orderData.amount,
    currency: orderData.currency,
    name: 'Vroomie',
    description: plan.name,
    order_id: orderData.orderId,
    prefill: { email: userEmail },
    theme: { color: '#EAB308' }, // Vroomie yellow
    modal: { backdropclose: false, escape: false },
    handler: async (response) => {
      try {
        const verified = await verifyPaymentSignature({
          orderId: response.razorpay_order_id,
          paymentId: response.razorpay_payment_id,
          signature: response.razorpay_signature,
          planId,
          userId,
        });
        onSuccess?.(verified);
      } catch (err) {
        onFailure?.(err);
      }
    },
  };

  const rzp = new window.Razorpay(options);
  rzp.on('payment.failed', (res) => {
    Logger.error('Razorpay payment failed', res.error);
    onFailure?.(new Error(res.error?.description || 'Payment failed'));
  });
  rzp.open();
}

// ── Signature verification (via Supabase Edge Function — server-side only) ────

export async function verifyPaymentSignature({ orderId, paymentId, signature, planId, userId }) {
  const { data, error } = await supabase.functions.invoke('verify-razorpay-payment', {
    body: { orderId, paymentId, signature, planId, userId },
  });

  if (error) {
    Logger.error('Payment verification failed', error);
    throw new Error(error.message || 'Verification failed');
  }

  Logger.info('Payment verified, subscription activated', data);
  return data;
}

// ── Subscription state helpers (client-side) ──────────────────────────────────

export async function getActiveSubscription(userId) {
  if (!userId) return null;
  const { data, error } = await supabase
    .from('subscriptions')
    .select('*, subscription_plans(*)')
    .eq('user_id', userId)
    .eq('status', 'active')
    .maybeSingle();

  if (error) {
    Logger.warn('Could not fetch subscription', error.message);
    return null;
  }
  return data;
}

export async function isSubscriptionActive(userId) {
  const sub = await getActiveSubscription(userId);
  if (!sub) return false;
  const notExpired = sub.expires_at && new Date(sub.expires_at) > new Date();
  return notExpired;
}

// ── API quota helpers ─────────────────────────────────────────────────────────

export async function getApiQuota(userId) {
  if (!userId) return SUBSCRIPTION_PLANS.FREE;
  const active = await isSubscriptionActive(userId);
  if (!active) return SUBSCRIPTION_PLANS.FREE;
  const sub = await getActiveSubscription(userId);
  return SUBSCRIPTION_PLANS[sub?.plan_id] || SUBSCRIPTION_PLANS.FREE;
}
