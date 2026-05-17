/**
 * razorpayService.js — Server-side Razorpay integration
 *
 * Required env vars (backend/.env):
 *   RAZORPAY_KEY_ID=
 *   RAZORPAY_SECRET=
 *   RAZORPAY_WEBHOOK_SECRET=
 *   SUPABASE_URL=
 *   SUPABASE_SERVICE_ROLE_KEY=
 *
 * Deploy as Supabase Edge Functions or a Node.js server.
 */

'use strict';

const crypto = require('crypto');

// ── Config ────────────────────────────────────────────────────────────────────

const RAZORPAY_KEY_ID     = process.env.RAZORPAY_KEY_ID     || '';
const RAZORPAY_SECRET     = process.env.RAZORPAY_SECRET     || '';
const WEBHOOK_SECRET      = process.env.RAZORPAY_WEBHOOK_SECRET || '';

if (!RAZORPAY_KEY_ID || !RAZORPAY_SECRET) {
  console.warn('[Razorpay] WARNING: RAZORPAY_KEY_ID / RAZORPAY_SECRET not set in environment.');
}

// ── Create Razorpay Order ─────────────────────────────────────────────────────

async function createOrder({ amount, currency = 'INR', receipt, notes = {} }) {
  const auth = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_SECRET}`).toString('base64');

  const response = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ amount, currency, receipt, notes }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`Razorpay order error: ${err?.error?.description || response.statusText}`);
  }

  const data = await response.json();
  return { orderId: data.id, amount: data.amount, currency: data.currency };
}

// ── Verify Payment Signature ──────────────────────────────────────────────────

function verifySignature({ orderId, paymentId, signature }) {
  if (!RAZORPAY_SECRET) throw new Error('RAZORPAY_SECRET not configured');
  const body = `${orderId}|${paymentId}`;
  const expected = crypto
    .createHmac('sha256', RAZORPAY_SECRET)
    .update(body)
    .digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

// ── Verify Webhook Signature ──────────────────────────────────────────────────

function verifyWebhookSignature({ rawBody, razorpaySignature }) {
  if (!WEBHOOK_SECRET) throw new Error('RAZORPAY_WEBHOOK_SECRET not configured');
  const expected = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(razorpaySignature));
}

// ── Handle Webhook Event ──────────────────────────────────────────────────────

/**
 * Call this from your POST /api/payments/webhook route.
 * supabaseAdmin = supabase client with service role key.
 */
async function handleWebhookEvent({ event, supabaseAdmin }) {
  const { event: eventName, payload } = event;

  switch (eventName) {
    case 'payment.captured': {
      const payment = payload.payment?.entity;
      if (!payment) break;
      const orderId = payment.order_id;
      // Fetch pending transaction and activate
      await _activateSubscriptionForOrder({ orderId, paymentId: payment.id, supabaseAdmin });
      break;
    }

    case 'subscription.activated': {
      const sub = payload.subscription?.entity;
      if (sub?.notes?.userId) {
        await supabaseAdmin
          .from('subscriptions')
          .update({ status: 'active', razorpay_subscription_id: sub.id })
          .eq('user_id', sub.notes.userId);
      }
      break;
    }

    case 'subscription.cancelled': {
      const sub = payload.subscription?.entity;
      if (sub?.notes?.userId) {
        await supabaseAdmin
          .from('subscriptions')
          .update({ status: 'cancelled' })
          .eq('user_id', sub.notes.userId);
      }
      break;
    }

    case 'payment.failed': {
      const payment = payload.payment?.entity;
      if (payment?.order_id) {
        await supabaseAdmin
          .from('payment_transactions')
          .update({ status: 'failed', failure_reason: payment.error_description })
          .eq('razorpay_order_id', payment.order_id);
      }
      break;
    }

    default:
      console.log(`[Webhook] Unhandled event: ${eventName}`);
  }
}

// ── Internal: Activate subscription after captured payment ───────────────────

async function _activateSubscriptionForOrder({ orderId, paymentId, supabaseAdmin }) {
  // Find the pending transaction
  const { data: txn } = await supabaseAdmin
    .from('payment_transactions')
    .select('*')
    .eq('razorpay_order_id', orderId)
    .maybeSingle();

  if (!txn) {
    console.warn(`[Razorpay] No transaction found for order ${orderId}`);
    return;
  }

  const PLAN_DURATIONS = {
    AI_ENABLED_MONTHLY: 30,
    AI_ENABLED_YEARLY:  365,
  };
  const days = PLAN_DURATIONS[txn.plan_id] || 30;
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + days);

  // Upsert subscription
  await supabaseAdmin.from('subscriptions').upsert({
    user_id:     txn.user_id,
    plan_id:     txn.plan_id,
    status:      'active',
    started_at:  new Date().toISOString(),
    expires_at:  expiresAt.toISOString(),
    payment_id:  paymentId,
    updated_at:  new Date().toISOString(),
  }, { onConflict: 'user_id' });

  // Mark transaction captured
  await supabaseAdmin
    .from('payment_transactions')
    .update({ status: 'captured', razorpay_payment_id: paymentId })
    .eq('razorpay_order_id', orderId);

  console.log(`[Razorpay] Subscription activated for user ${txn.user_id}, plan ${txn.plan_id}`);
}

module.exports = { createOrder, verifySignature, verifyWebhookSignature, handleWebhookEvent };
