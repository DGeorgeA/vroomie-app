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
import { activateSubscription } from './subscriptionService';

// Razorpay plan ids -> subscriber_base plan ids. The app's pro gate
// (AuthContext -> isProUser) reads subscriber_base, so a verified Razorpay
// payment MUST be reflected there or the user pays and gets nothing.
const RZP_TO_LOCAL_PLAN = {
  AI_ENABLED_MONTHLY: 'monthly',
  AI_ENABLED_YEARLY: 'yearly',
};

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
    script.onerror = () => {
      // Remove the dead tag so a retry can append a fresh one
      script.remove();
      resolve(false);
    };
    document.head.appendChild(script);
  });
}

// ── Order creation (calls your backend / Supabase Edge Function) ──────────────

export async function createRazorpayOrder({ planId, userId, userEmail }) {
  const plan = SUBSCRIPTION_PLANS[planId];
  if (!plan || plan.price === 0) throw new Error('Invalid paid plan');

  // Call Supabase Edge Function (deploy separately — see backend/payments)
  const { data, error } = await supabase.functions.invoke('create-razorpay-order', {
    body: {
      planId,
      amount: plan.price * 100, // Razorpay expects paise
      currency: plan.currency,
      userId,
      receipt: `vrm_${userId?.slice(0, 8)}_${Date.now()}`,
      // Reconciliation metadata — surfaces in the Razorpay dashboard and webhooks
      notes: { planId, userId: userId || 'anonymous' },
    },
  });

  if (error) {
    Logger.error('Razorpay order creation failed', error);
    throw new Error(error.message || 'Order creation failed');
  }
  return data; // { orderId, amount, currency }
}

// ── Open Razorpay checkout ────────────────────────────────────────────────────

/**
 * Failure semantics:
 *  - Failures BEFORE the checkout modal opens (SDK load, missing key, order
 *    creation) THROW, so callers can run their fallback path (SubscriptionPage
 *    falls back to UPI in its catch block — previously unreachable because
 *    these errors were swallowed into onFailure).
 *  - Failures AFTER the modal opens (payment declined, user dismissed,
 *    verification failed) arrive asynchronously via onFailure.
 */
export async function openRazorpayCheckout({ planId, userId, userEmail, onSuccess, onFailure }) {
  const sdkReady = await loadRazorpaySDK();
  if (!sdkReady || !window.Razorpay) {
    const msg = 'Razorpay SDK could not be loaded. Check your internet connection.';
    Logger.error(msg);
    throw new Error(msg);
  }

  if (!RAZORPAY_KEY_ID) {
    const msg = 'VITE_RAZORPAY_KEY_ID is not configured.';
    Logger.error(msg);
    throw new Error(msg);
  }

  // Throws on failure — caller's catch handles it (UPI fallback)
  const orderData = await createRazorpayOrder({ planId, userId, userEmail });

  const plan = SUBSCRIPTION_PLANS[planId];

  const options = {
    key: RAZORPAY_KEY_ID,
    amount: orderData.amount,
    currency: orderData.currency,
    name: 'Vroomie',
    description: plan.name,
    order_id: orderData.orderId,
    prefill: { email: userEmail },
    notes: { planId, userId: userId || 'anonymous' },
    theme: { color: '#EAB308' }, // Vroomie yellow
    modal: {
      backdropclose: false,
      escape: false,
      ondismiss: () => {
        Logger.info('Razorpay checkout dismissed by user');
        onFailure?.(new Error('Payment was cancelled'));
      },
    },
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

  // Sync subscriber_base — the table the app's pro gate actually reads.
  // Without this, a verified Razorpay payment activated only the backend
  // 'subscriptions' table and the user still appeared as Free in the app.
  const localPlan = RZP_TO_LOCAL_PLAN[planId];
  if (localPlan && userId) {
    try {
      await activateSubscription(userId, localPlan);
    } catch (syncErr) {
      Logger.error('Payment verified but subscription sync failed', syncErr);
      throw new Error('Payment received but activation failed — please contact support with payment id ' + paymentId);
    }
  }

  Logger.info('Payment verified, subscription activated', data);
  return data;
}

// ── Subscription state helpers (client-side) ──────────────────────────────────

export async function getActiveSubscription(userId) {
  if (!userId) return null;
  // No join on subscription_plans: the joined data is unused by the app and a
  // missing FK/table in the live DB would error the whole query, silently
  // degrading a paying user to Free.
  const { data, error } = await supabase
    .from('subscriptions')
    .select('*')
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
  return Boolean(sub.expires_at && new Date(sub.expires_at) > new Date());
}

// ── API quota helpers ─────────────────────────────────────────────────────────

export async function getApiQuota(userId) {
  if (!userId) return SUBSCRIPTION_PLANS.FREE;
  // Single round-trip (was three sequential queries for the same row)
  const sub = await getActiveSubscription(userId);
  const active = Boolean(sub?.expires_at && new Date(sub.expires_at) > new Date());
  if (!active) return SUBSCRIPTION_PLANS.FREE;
  return SUBSCRIPTION_PLANS[sub.plan_id] || SUBSCRIPTION_PLANS.FREE;
}
