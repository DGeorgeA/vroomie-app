/**
 * rateLimitMiddleware.js — API guardrails for Vroomie public API
 *
 * Implements:
 *  - API key validation
 *  - Per-minute rate limiting (in-memory, swap to Redis in production)
 *  - Monthly quota tracking (via Supabase)
 *  - Payload size limits
 *  - CORS restrictions
 *  - Timeout handling
 */

'use strict';

const crypto = require('crypto');

// ── In-memory rate limiter (RPM) ─────────────────────────────────────────────
// For production: replace with Redis + sliding-window algorithm

const _rpmBuckets = new Map(); // apiKey → { count, windowStart }

const PLAN_LIMITS = {
  free:       { rpm: 10,  monthly: 1000 },
  growth:     { rpm: 60,  monthly: 50000 },
  enterprise: { rpm: 300, monthly: Infinity },
};

function checkRpm(apiKey, planTier = 'free') {
  const limit = PLAN_LIMITS[planTier]?.rpm || PLAN_LIMITS.free.rpm;
  const now = Date.now();
  const bucket = _rpmBuckets.get(apiKey) || { count: 0, windowStart: now };

  // Reset window every 60 seconds
  if (now - bucket.windowStart > 60_000) {
    bucket.count = 0;
    bucket.windowStart = now;
  }

  bucket.count += 1;
  _rpmBuckets.set(apiKey, bucket);

  return { allowed: bucket.count <= limit, remaining: Math.max(0, limit - bucket.count), limit };
}

// ── API Key validation ────────────────────────────────────────────────────────

async function validateApiKey(apiKey, supabaseAdmin) {
  if (!apiKey || !apiKey.startsWith('vrm_')) return null;

  // Hash the key before DB lookup to avoid storing keys in plaintext
  const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');

  const { data, error } = await supabaseAdmin
    .from('api_keys')
    .select('user_id, plan_tier, is_active, monthly_calls_used, monthly_reset_at')
    .eq('key_hash', keyHash)
    .eq('is_active', true)
    .maybeSingle();

  if (error || !data) return null;

  // Auto-reset monthly counter if a new billing month has started
  const resetAt = new Date(data.monthly_reset_at);
  const now = new Date();
  if (now >= resetAt) {
    const nextReset = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    await supabaseAdmin
      .from('api_keys')
      .update({ monthly_calls_used: 0, monthly_reset_at: nextReset.toISOString() })
      .eq('key_hash', keyHash);
    data.monthly_calls_used = 0;
  }

  return data;
}

// ── Middleware factory ────────────────────────────────────────────────────────

/**
 * @param {object} supabaseAdmin — Supabase client with service role key
 * @param {object} options
 * @param {number} options.maxPayloadMb — Max request body size in MB (default: 5)
 * @param {number} options.timeoutMs    — Request timeout in ms (default: 30000)
 * @param {string[]} options.allowedOrigins — Whitelisted CORS origins
 */
function createApiGuardrails(supabaseAdmin, {
  maxPayloadMb    = 5,
  timeoutMs       = 30_000,
  allowedOrigins  = [],
} = {}) {

  return async function apiGuardrails(req, res, next) {
    // ── 1. CORS ───────────────────────────────────────────────────────────────
    const origin = req.headers.origin || '';
    if (allowedOrigins.length > 0 && !allowedOrigins.includes(origin)) {
      return res.status(403).json({ error: 'CORS policy: origin not permitted' });
    }
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Client-Version');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);

    // ── 2. HTTPS enforcement ─────────────────────────────────────────────────
    const proto = req.headers['x-forwarded-proto'] || req.protocol;
    if (proto !== 'https' && process.env.NODE_ENV === 'production') {
      return res.status(400).json({ error: 'HTTPS required. Plain HTTP is not permitted.' });
    }

    // ── 3. Payload size ──────────────────────────────────────────────────────
    const contentLength = parseInt(req.headers['content-length'] || '0', 10);
    const maxBytes = maxPayloadMb * 1024 * 1024;
    if (contentLength > maxBytes) {
      return res.status(413).json({
        error: `Payload too large. Maximum allowed: ${maxPayloadMb} MB.`,
      });
    }

    // ── 4. API Key extraction ────────────────────────────────────────────────
    const authHeader = req.headers.authorization || '';
    const apiKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!apiKey) {
      return res.status(401).json({
        error: 'Missing API key. Include Authorization: Bearer YOUR_API_KEY in every request.',
      });
    }

    // ── 5. Key validation ────────────────────────────────────────────────────
    const keyData = await validateApiKey(apiKey, supabaseAdmin).catch(() => null);
    if (!keyData) {
      return res.status(401).json({ error: 'Invalid or revoked API key.' });
    }

    // ── 6. Monthly quota ─────────────────────────────────────────────────────
    const planLimits = PLAN_LIMITS[keyData.plan_tier] || PLAN_LIMITS.free;
    if (keyData.monthly_calls_used >= planLimits.monthly) {
      res.setHeader('X-RateLimit-Limit-Monthly', planLimits.monthly);
      res.setHeader('X-RateLimit-Remaining-Monthly', 0);
      return res.status(429).json({
        error: 'Monthly API quota exceeded.',
        limit: planLimits.monthly,
        contact: 'sales@gofriday.shop',
        code: 'QUOTA_EXCEEDED',
      });
    }

    // ── 7. Per-minute rate limit ─────────────────────────────────────────────
    const rpm = checkRpm(apiKey, keyData.plan_tier);
    res.setHeader('X-RateLimit-Limit-RPM', rpm.limit);
    res.setHeader('X-RateLimit-Remaining-RPM', rpm.remaining);

    if (!rpm.allowed) {
      res.setHeader('Retry-After', '60');
      return res.status(429).json({
        error: 'Rate limit exceeded. Please slow down.',
        retryAfter: 60,
        code: 'RATE_LIMIT_EXCEEDED',
      });
    }

    // ── 8. Timeout ───────────────────────────────────────────────────────────
    const timer = setTimeout(() => {
      if (!res.headersSent) {
        res.status(504).json({ error: 'Request timed out.' });
      }
    }, timeoutMs);
    res.on('finish', () => clearTimeout(timer));

    // ── 9. Increment usage counter (fire-and-forget) ─────────────────────────
    supabaseAdmin
      .from('api_keys')
      .update({ monthly_calls_used: (keyData.monthly_calls_used || 0) + 1 })
      .eq('key_hash', crypto.createHash('sha256').update(apiKey).digest('hex'))
      .then(() => {})
      .catch(() => {});

    // ── 10. Attach context to request ────────────────────────────────────────
    req.vroomie = {
      userId: keyData.user_id,
      planTier: keyData.plan_tier,
      quotaRemaining: planLimits.monthly - keyData.monthly_calls_used - 1,
    };

    next();
  };
}

module.exports = { createApiGuardrails, validateApiKey, checkRpm, PLAN_LIMITS };
