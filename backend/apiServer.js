/**
 * apiServer.js — Vroomie Public API server
 *
 * Wires up all routes with guardrails middleware.
 * Run: node apiServer.js
 *
 * Env vars needed (backend/.env):
 *   RAZORPAY_KEY_ID=
 *   RAZORPAY_SECRET=
 *   RAZORPAY_WEBHOOK_SECRET=
 *   SUPABASE_URL=
 *   SUPABASE_SERVICE_ROLE_KEY=
 *   ALLOWED_ORIGINS=https://vroomie.in,https://app.vroomie.in
 *   PORT=3001
 */

'use strict';

require('dotenv').config();

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { createApiGuardrails } = require('./middleware/rateLimitMiddleware');
const { createWebhookHandler, rawBodyMiddleware } = require('./payments/webhookHandler');
const { createOrder, verifySignature } = require('./payments/razorpayService');
const crypto = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Supabase admin client (server-side only) ───────────────────────────────
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

// ── CORS origins from env ──────────────────────────────────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

// ── Guardrails middleware ──────────────────────────────────────────────────
const apiGuardrails = createApiGuardrails(supabaseAdmin, {
  maxPayloadMb:   5,
  timeoutMs:      30_000,
  allowedOrigins,
});

// ── Webhook route (raw body MUST come first) ────────────────────────────────
app.post(
  '/api/payments/webhook',
  rawBodyMiddleware,
  createWebhookHandler(supabaseAdmin)
);

// ── Standard JSON body parser for all other routes ─────────────────────────
app.use(express.json({ limit: '6mb' }));

// ── Health check (no auth required) ────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString(), version: '1.0' });
});

// ── Apply guardrails to all /api/v1 routes ─────────────────────────────────
app.use('/api/v1', apiGuardrails);

// ── POST /api/v1/analyse ────────────────────────────────────────────────────
app.post('/api/v1/analyse', async (req, res) => {
  const { audio_b64, format = 'wav', sample_rate = 16000, sensitivity = 'medium' } = req.body;

  if (!audio_b64) {
    return res.status(400).json({ error: 'audio_b64 is required' });
  }

  // Validate format
  const SUPPORTED_FORMATS = ['wav', 'mp3', 'pcm'];
  if (!SUPPORTED_FORMATS.includes(format)) {
    return res.status(400).json({
      error: `Unsupported format: ${format}. Supported: ${SUPPORTED_FORMATS.join(', ')}`,
    });
  }

  // Stub: in production this calls the inference service
  const requestId = `req_${crypto.randomBytes(8).toString('hex')}`;
  res.json({
    request_id: requestId,
    timestamp:  new Date().toISOString(),
    anomalies: [],
    silent_segments_pct: 0,
    inference_ms: 0,
    quota_remaining: req.vroomie?.quotaRemaining ?? 0,
    _note: 'Inference pipeline not yet connected. Integrate your ML service here.',
  });
});

// ── POST /api/v1/session/start ──────────────────────────────────────────────
app.post('/api/v1/session/start', (req, res) => {
  const sessionId = `ses_${crypto.randomBytes(10).toString('hex')}`;
  res.json({ session_id: sessionId, started_at: new Date().toISOString() });
});

// ── POST /api/v1/session/stop ───────────────────────────────────────────────
app.post('/api/v1/session/stop', (req, res) => {
  const { session_id } = req.body;
  if (!session_id) return res.status(400).json({ error: 'session_id is required' });
  res.json({ session_id, stopped_at: new Date().toISOString(), duration_ms: 0 });
});

// ── GET /api/v1/history ─────────────────────────────────────────────────────
app.get('/api/v1/history', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);
  const page  = Math.max(parseInt(req.query.page  || '1',  10), 1);
  const offset = (page - 1) * limit;

  const { data, error, count } = await supabaseAdmin
    .from('analysis_logs')
    .select('*', { count: 'exact' })
    .eq('user_id', req.vroomie.userId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) return res.status(500).json({ error: 'Could not fetch history' });
  res.json({ sessions: data || [], total: count || 0, page });
});

// ── GET /api/v1/quota ───────────────────────────────────────────────────────
app.get('/api/v1/quota', async (req, res) => {
  const keyHash = crypto
    .createHash('sha256')
    .update(req.headers.authorization?.slice(7) || '')
    .digest('hex');

  const { data } = await supabaseAdmin
    .from('api_keys')
    .select('plan_tier, monthly_calls_used, monthly_reset_at')
    .eq('key_hash', keyHash)
    .maybeSingle();

  if (!data) return res.status(401).json({ error: 'Key not found' });

  const { PLAN_LIMITS } = require('./middleware/rateLimitMiddleware');
  const limits = PLAN_LIMITS[data.plan_tier] || PLAN_LIMITS.free;

  res.json({
    plan: data.plan_tier,
    monthly_limit: limits.monthly,
    used: data.monthly_calls_used,
    remaining: Math.max(0, limits.monthly - data.monthly_calls_used),
    reset_at: data.monthly_reset_at,
  });
});

// ── POST /api/payments/create-order ────────────────────────────────────────
// Called by frontend to create a Razorpay order
app.post('/api/payments/create-order', express.json(), async (req, res) => {
  const { planId, userId, amount, currency = 'INR', receipt } = req.body;
  if (!planId || !userId || !amount) {
    return res.status(400).json({ error: 'planId, userId, amount are required' });
  }
  try {
    const order = await createOrder({ amount, currency, receipt: receipt || `vrm_${Date.now()}` });
    // Record pending transaction
    await supabaseAdmin.from('payment_transactions').insert({
      user_id: userId,
      plan_id: planId,
      amount,
      currency,
      status: 'pending',
      razorpay_order_id: order.orderId,
    });
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/payments/verify ───────────────────────────────────────────────
app.post('/api/payments/verify', express.json(), async (req, res) => {
  const { orderId, paymentId, signature, planId, userId } = req.body;
  if (!orderId || !paymentId || !signature) {
    return res.status(400).json({ error: 'orderId, paymentId, signature required' });
  }
  try {
    const valid = verifySignature({ orderId, paymentId, signature });
    if (!valid) return res.status(401).json({ error: 'Invalid payment signature' });

    // Activate subscription (reuse webhook logic)
    const { handleWebhookEvent } = require('./payments/razorpayService');
    // Simulate captured event
    await supabaseAdmin.from('payment_transactions').update({
      status: 'captured',
      razorpay_payment_id: paymentId,
      razorpay_signature: signature,
    }).eq('razorpay_order_id', orderId);

    const PLAN_DURATIONS = { AI_ENABLED_MONTHLY: 30, AI_ENABLED_YEARLY: 365 };
    const days = PLAN_DURATIONS[planId] || 30;
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + days);

    await supabaseAdmin.from('subscriptions').upsert({
      user_id: userId, plan_id: planId, status: 'active',
      started_at: new Date().toISOString(),
      expires_at: expiresAt.toISOString(),
      payment_id: paymentId, updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' });

    res.json({ success: true, expiresAt, plan: planId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start server ───────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[Vroomie API] Listening on port ${PORT}`);
  console.log(`[Vroomie API] Allowed origins: ${allowedOrigins.join(', ') || 'ALL (dev)'}`);
});

module.exports = app;
