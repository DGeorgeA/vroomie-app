/**
 * webhookHandler.js — POST /api/payments/webhook
 *
 * Mount this route on your Express/Node server.
 * Reads raw body BEFORE json() middleware to verify Razorpay HMAC signature.
 */

'use strict';

const { verifyWebhookSignature, handleWebhookEvent } = require('./razorpayService');

/**
 * Express middleware to capture raw body for HMAC verification.
 * Must be mounted BEFORE express.json() for this route.
 */
function rawBodyMiddleware(req, res, next) {
  let data = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => { data += chunk; });
  req.on('end', () => {
    req.rawBody = data;
    next();
  });
}

/**
 * Webhook route handler — verifies Razorpay signature and delegates to event handler.
 * @param {object} supabaseAdmin — Supabase client with service role key
 */
function createWebhookHandler(supabaseAdmin) {
  return async function webhookHandler(req, res) {
    // 1. Extract signature header
    const razorpaySignature = req.headers['x-razorpay-signature'];
    if (!razorpaySignature) {
      return res.status(400).json({ error: 'Missing x-razorpay-signature header' });
    }

    // 2. Verify HMAC signature
    let signatureValid = false;
    try {
      signatureValid = verifyWebhookSignature({
        rawBody: req.rawBody,
        razorpaySignature,
      });
    } catch (err) {
      console.error('[Webhook] Signature verification error:', err.message);
      return res.status(500).json({ error: 'Signature verification failed' });
    }

    if (!signatureValid) {
      console.warn('[Webhook] Invalid signature — potential spoofing attempt');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // 3. Parse event
    let event;
    try {
      event = JSON.parse(req.rawBody);
    } catch {
      return res.status(400).json({ error: 'Invalid JSON payload' });
    }

    // 4. Acknowledge immediately (Razorpay requires <5s response)
    res.status(200).json({ received: true });

    // 5. Process event asynchronously
    handleWebhookEvent({ event, supabaseAdmin }).catch((err) => {
      console.error('[Webhook] Event processing error:', err.message);
    });
  };
}

module.exports = { createWebhookHandler, rawBodyMiddleware };
