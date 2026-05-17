import React, { useState } from 'react';
import {
  Code2, Key, Zap, Shield, Copy, CheckCheck,
  ChevronDown, ChevronRight, Globe, Lock, AlertTriangle, Mail, Headphones, Terminal, Smartphone, Radio
} from 'lucide-react';

// ─── Reuse Settings sub-components style ─────────────────────────────────────

function SectionHeader({ title }) {
  return (
    <h3 className="text-xs font-display font-bold text-zinc-500 uppercase tracking-widest mb-3 px-1">
      {title}
    </h3>
  );
}

function Card({ children, className = '' }) {
  return (
    <div className={`bg-zinc-900/60 border border-white/5 rounded-2xl overflow-hidden backdrop-blur-sm mb-6 ${className}`}>
      {children}
    </div>
  );
}

// ─── Code block with copy ─────────────────────────────────────────────────────

function CodeBlock({ code, language = 'bash', id }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <div className="relative group rounded-xl bg-zinc-950 border border-white/8 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-white/5 bg-zinc-900/50">
        <span className="text-[10px] font-mono font-bold text-zinc-500 uppercase tracking-widest">{language}</span>
        <button
          id={`copy-${id}`}
          onClick={copy}
          className="flex items-center gap-1.5 text-[10px] text-zinc-500 hover:text-yellow-400 transition-colors"
        >
          {copied ? <CheckCheck className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <pre className="text-xs text-zinc-300 font-mono p-4 overflow-x-auto leading-relaxed whitespace-pre-wrap">{code}</pre>
    </div>
  );
}

// ─── Collapsible endpoint block ───────────────────────────────────────────────

function Endpoint({ method, path, description, children, id }) {
  const [open, setOpen] = useState(false);
  const methodColors = {
    POST:   'bg-blue-500/15 text-blue-400 border-blue-500/25',
    GET:    'bg-emerald-500/15 text-emerald-400 border-emerald-500/25',
    DELETE: 'bg-red-500/15 text-red-400 border-red-500/25',
  };
  return (
    <div className="border-b border-white/5 last:border-0">
      <button
        id={`endpoint-${id}`}
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-3 px-4 py-3.5 hover:bg-white/3 transition-colors text-left"
      >
        <span className={`text-[10px] font-bold px-2 py-0.5 rounded border font-mono flex-shrink-0 ${methodColors[method] || 'bg-zinc-700 text-zinc-400 border-zinc-600'}`}>
          {method}
        </span>
        <code className="text-sm text-white font-mono flex-1">{path}</code>
        <span className="text-xs text-zinc-500 hidden sm:block">{description}</span>
        {open ? <ChevronDown className="w-4 h-4 text-zinc-500 flex-shrink-0" /> : <ChevronRight className="w-4 h-4 text-zinc-500 flex-shrink-0" />}
      </button>
      {open && (
        <div className="px-4 pb-4 border-t border-white/5 bg-zinc-950/40 space-y-4 pt-4">
          {children}
        </div>
      )}
    </div>
  );
}

// ─── Rate limit tier badge ────────────────────────────────────────────────────

function TierBadge({ label, cls }) {
  return (
    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${cls}`}>{label}</span>
  );
}

export default function ApiDocs() {
  const BASE = 'https://api.vroomie.in/v1';

  return (
    <div className="max-w-2xl mx-auto pb-16 w-full px-4">

      {/* ── Page Header ─────────────────────────────────────────────────── */}
      <div className="mb-8 mt-4">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-2xl bg-yellow-500/10 border border-yellow-500/20 flex items-center justify-center">
            <Code2 className="w-5 h-5 text-yellow-400" />
          </div>
          <div>
            <h2 className="text-3xl font-display font-bold text-white tracking-tight">API Docs</h2>
            <p className="text-zinc-500 text-sm">Integrate Vroomie's audio diagnostics into your own application.</p>
          </div>
        </div>
      </div>

      {/* ══ INTRODUCTION ════════════════════════════════════════════════════ */}
      <SectionHeader title="Introduction" />
      <Card>
        <div className="p-5 space-y-3">
          <p className="text-sm text-zinc-300 leading-relaxed">
            Vroomie APIs allow external applications to integrate real-time automotive anomaly detection and AI-assisted vehicle diagnostics into their own platforms.
          </p>
          <p className="text-xs text-zinc-500 leading-relaxed">
            Our state-of-the-art DSP and audio models run at high performance to analyze vehicle recording sessions, identify mechanical anomalies, and offer recommendations instantly.
          </p>
        </div>
      </Card>

      {/* ══ AUTHENTICATION ════════════════════════════════════════════════ */}
      <SectionHeader title="Authentication" />
      <Card>
        <div className="p-5 space-y-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-zinc-800/80 flex items-center justify-center text-purple-400 flex-shrink-0">
              <Key className="w-4 h-4" />
            </div>
            <div>
              <p className="text-sm font-medium text-white">API Key — Bearer Token</p>
              <p className="text-xs text-zinc-500">Pass your key in every request header.</p>
            </div>
          </div>
          
          <div className="text-xs text-zinc-400 space-y-2">
            <p>To authenticate requests, generate an API key from the Vroomie Developer Portal, then supply it as a Bearer token in the <code className="text-yellow-400 bg-zinc-950 px-1 py-0.5 rounded">Authorization</code> header.</p>
          </div>

          <CodeBlock
            id="auth-header"
            language="http"
            code={`Authorization: Bearer YOUR_API_KEY\nContent-Type: application/json`}
          />
        </div>
      </Card>

      {/* ══ CORE ENDPOINTS ═════════════════════════════════════════════════ */}
      <SectionHeader title="Core Endpoints" />
      <Card>
        {/* POST /api/analyze-audio */}
        <Endpoint id="analyze-audio" method="POST" path="/api/analyze-audio" description="Submit vehicle audio for real-time anomaly detection">
          <div className="space-y-3">
            <p className="text-xs text-zinc-400">
              Upload a Base64-encoded audio clip to analyze the audio engine or components for anomaly matching against our reference fingerprints.
            </p>
            
            <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Request Payload</p>
            <CodeBlock id="analyze-req" language="json" code={`{
  "audio_b64": "UklGRiYAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=",
  "format": "wav",           // "wav" | "mp3" | "pcm"
  "sample_rate": 16000,
  "channels": 1,
  "sensitivity": "medium"   // "low" | "medium" | "high"
}`} />

            <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Response (200 OK)</p>
            <CodeBlock id="analyze-res" language="json" code={`{
  "request_id": "req_5a1b3c9e",
  "timestamp": "2026-05-17T12:00:00Z",
  "status": "anomaly_detected",
  "anomalies": [
    {
      "label": "Engine Knocking",
      "confidence": 0.89,
      "severity": "high",
      "onset_ms": 1200,
      "offset_ms": 3500
    }
  ],
  "silent_segments_pct": 5,
  "inference_ms": 185,
  "quota_remaining": 899
}`} />
          </div>
        </Endpoint>

        {/* POST /api/session/start */}
        <Endpoint id="session-start" method="POST" path="/api/session/start" description="Initialize a live diagnostics tracking session">
          <div className="space-y-3">
            <p className="text-xs text-zinc-400">
              Starts a dynamic tracking session for streaming audio diagnostics. Returns a session ID.
            </p>
            
            <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Request Payload</p>
            <CodeBlock id="sess-start-req" language="json" code={`{
  "device_id": "client_phone_001",
  "vehicle_meta": {
    "make": "Toyota",
    "model": "Corolla",
    "year": 2021
  }
}`} />

            <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Response (200 OK)</p>
            <CodeBlock id="sess-start-res" language="json" code={`{
  "session_id": "ses_9e8d7c6b5a",
  "status": "initialized",
  "started_at": "2026-05-17T12:05:00Z"
}`} />
          </div>
        </Endpoint>

        {/* POST /api/session/stop */}
        <Endpoint id="session-stop" method="POST" path="/api/session/stop" description="Complete and save the active diagnostics session">
          <div className="space-y-3">
            <p className="text-xs text-zinc-400">
              Concludes the dynamic diagnostic session and generates a cumulative report.
            </p>
            
            <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Request Payload</p>
            <CodeBlock id="sess-stop-req" language="json" code={`{
  "session_id": "ses_9e8d7c6b5a",
  "save_history": true
}`} />

            <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Response (200 OK)</p>
            <CodeBlock id="sess-stop-res" language="json" code={`{
  "session_id": "ses_9e8d7c6b5a",
  "status": "completed",
  "duration_ms": 15400,
  "total_anomalies_detected": 1,
  "report_summary": "Session ended cleanly. Minor engine tap identified."
}`} />
          </div>
        </Endpoint>

        {/* GET /api/history */}
        <Endpoint id="history" method="GET" path="/api/history" description="Retrieve paginated diagnostics history logs">
          <div className="space-y-3">
            <p className="text-xs text-zinc-400">
              Fetches all past diagnostic records associated with the authenticated developer account.
            </p>
            
            <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Response (200 OK)</p>
            <CodeBlock id="history-res" language="json" code={`{
  "total": 42,
  "page": 1,
  "limit": 20,
  "sessions": [
    {
      "id": "ses_9e8d7c6b5a",
      "status": "completed",
      "created_at": "2026-05-17T12:05:00Z",
      "duration_ms": 15400,
      "detected_anomaly_name": "Engine Knocking",
      "confidence_score": 0.89
    }
  ]
}`} />
          </div>
        </Endpoint>

        {/* GET /api/health */}
        <Endpoint id="health" method="GET" path="/api/health" description="Check API server health status">
          <div className="space-y-3">
            <p className="text-xs text-zinc-400">
              Returns the server availability, system status, and microservices health indicator.
            </p>

            <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Response (200 OK)</p>
            <CodeBlock id="health-res" language="json" code={`{
  "status": "ok",
  "version": "1.0.0",
  "timestamp": "2026-05-17T12:10:00Z",
  "microservices": {
    "inference_engine": "healthy",
    "database": "healthy",
    "payment_gateway": "healthy"
  }
}`} />
          </div>
        </Endpoint>
      </Card>

      {/* ══ AUDIO REQUIREMENTS ════════════════════════════════════════════ */}
      <SectionHeader title="Audio Requirements" />
      <Card>
        <div className="p-5 space-y-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-zinc-800/80 flex items-center justify-center text-blue-400 flex-shrink-0">
              <Headphones className="w-4 h-4" />
            </div>
            <div>
              <p className="text-sm font-medium text-white">Audio Formats & Signal Processing</p>
              <p className="text-xs text-zinc-500">Requirements for high-accuracy anomaly detection.</p>
            </div>
          </div>
          
          <div className="grid grid-cols-2 gap-4">
            <div className="border border-white/5 rounded-xl p-3 bg-zinc-950/40">
              <p className="text-xs font-bold text-zinc-400 uppercase tracking-wide mb-1">Supported Formats</p>
              <ul className="text-xs text-zinc-500 space-y-1 list-disc pl-4">
                <li><strong className="text-white">WAV</strong> (Standard PCM audio)</li>
                <li><strong className="text-white">MP3</strong> (Compressed audio streams)</li>
                <li><strong className="text-white">PCM</strong> (Raw sample streams)</li>
              </ul>
            </div>
            <div className="border border-white/5 rounded-xl p-3 bg-zinc-950/40">
              <p className="text-xs font-bold text-zinc-400 uppercase tracking-wide mb-1">Recommended Specs</p>
              <ul className="text-xs text-zinc-500 space-y-1 list-disc pl-4">
                <li>Channels: <strong className="text-white">mono</strong> (1 channel)</li>
                <li>Sample Rate: <strong className="text-white">16kHz</strong></li>
                <li>Duration: <strong className="text-white">5 - 30 seconds</strong></li>
              </ul>
            </div>
          </div>

          <p className="text-xs text-zinc-500 leading-relaxed">
            Note: Multi-channel audio is downmixed to mono, and other sample rates are automatically resampled to 16kHz before processing, which can slightly increase latency. For fastest results, deliver 16kHz mono audio directly.
          </p>
        </div>
      </Card>

      {/* ══ SDK / INTEGRATION GUIDE ═══════════════════════════════════════ */}
      <SectionHeader title="SDK / Integration Guide" />
      <Card>
        <div className="p-5 space-y-4">
          {/* Web Integration */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Terminal className="w-4 h-4 text-yellow-500" />
              <p className="text-sm font-semibold text-white">Web Browser Integration (JS/TS)</p>
            </div>
            <p className="text-xs text-zinc-400">
              Record microphone audio and submit it cleanly in vanilla Javascript:
            </p>
            <CodeBlock id="js-sdk" language="javascript" code={`const mediaRecorder = new MediaRecorder(stream);
const audioChunks = [];

mediaRecorder.ondataavailable = event => audioChunks.push(event.data);
mediaRecorder.onstop = async () => {
  const audioBlob = new Blob(audioChunks, { type: 'audio/wav' });
  const reader = new FileReader();
  reader.readAsDataURL(audioBlob);
  reader.onloadend = async () => {
    const base64Audio = reader.result.split(',')[1];
    const response = await fetch('https://api.vroomie.in/v1/api/analyze-audio', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer YOUR_API_KEY',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ audio_b64: base64Audio, format: 'wav' })
    });
    const result = await response.json();
    console.log('Diagnostic result:', result);
  };
};`} />
          </div>

          {/* Mobile Integration */}
          <div className="space-y-2 pt-2 border-t border-white/5">
            <div className="flex items-center gap-2">
              <Smartphone className="w-4 h-4 text-cyan-400" />
              <p className="text-sm font-semibold text-white">Mobile Integration (iOS / Android)</p>
            </div>
            <p className="text-xs text-zinc-400">
              For iOS (Swift) and Android (Kotlin), record audio using native audio pipelines, convert to standard WAV mono at 16000Hz, encode as Base64, and transmit.
            </p>
          </div>

          {/* Streaming Audio */}
          <div className="space-y-2 pt-2 border-t border-white/5">
            <div className="flex items-center gap-2">
              <Radio className="w-4 h-4 text-purple-400" />
              <p className="text-sm font-semibold text-white">Streaming Audio Support</p>
            </div>
            <p className="text-xs text-zinc-400">
              Websocket pipelines are available for active, low-latency analysis of vehicle sounds. Establish a secure socket connection at <code className="text-yellow-400 bg-zinc-950 px-1 py-0.5 rounded">wss://api.vroomie.in/v1/stream</code> and pipe PCM binary frames directly.
            </p>
          </div>
        </div>
      </Card>

      {/* ══ RATE LIMITS ════════════════════════════════════════════════════ */}
      <SectionHeader title="Rate Limits & API Guardrails" />
      <Card>
        <div className="p-5 space-y-4">
          {/* Exact text block requirement */}
          <div className="border border-white/8 bg-zinc-950/60 rounded-xl p-4 space-y-3">
            <p className="text-xs font-bold text-zinc-500 uppercase tracking-widest">Free Plan Allowance</p>
            <div className="text-sm text-zinc-300 font-semibold space-y-1">
              <p className="text-yellow-400 text-lg">FREE PLAN:</p>
              <p>• 100 API calls/day</p>
              <p>OR</p>
              <p>• 1,000 API calls/month</p>
            </div>
            <div className="text-xs text-zinc-500 leading-relaxed border-t border-white/5 pt-3">
              <span className="text-red-400 font-semibold">AFTER LIMIT:</span><br />
              "Please contact <a href="mailto:sales@gofriday.shop" className="text-yellow-400 hover:underline">sales@gofriday.shop</a> for extended access."
            </div>
          </div>

          {/* Overage and throttling notice */}
          <div className="flex items-start gap-3 p-3 rounded-xl border border-yellow-500/20 bg-yellow-500/5">
            <AlertTriangle className="w-4 h-4 text-yellow-400 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-zinc-400 leading-relaxed">
              Exceeded calls will trigger <code className="text-yellow-400 text-[11px] bg-yellow-500/10 px-1 rounded">HTTP 429 Too Many Requests</code>. Throttling guardrails include a strict 10 requests per minute burst limit.
            </p>
          </div>
        </div>
      </Card>

      {/* ══ GUARDRAILS ════════════════════════════════════════════════════ */}
      <SectionHeader title="Platform Security & Guardrails" />
      <Card>
        <div className="p-5 space-y-3">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-9 h-9 rounded-xl bg-zinc-800/80 flex items-center justify-center text-red-400 flex-shrink-0">
              <Shield className="w-4 h-4" />
            </div>
            <p className="text-sm font-medium text-white">Production Guardrail Metrics</p>
          </div>
          {[
            { icon: Lock, color: 'text-purple-400', title: 'HTTPS Only', desc: 'All API traffic must use TLS 1.2+. HTTP requests are rejected with a 400 Bad Request.' },
            { icon: Zap, color: 'text-yellow-400', title: 'Request Throttling & Rate Limiting', desc: 'Protected by our active express middleware with in-memory bucket token rate limits.' },
            { icon: AlertTriangle, color: 'text-orange-400', title: 'Payload Size Limits', desc: 'Audio uploads are capped at 5 MB maximum size to prevent abuse and buffer overrun.' },
            { icon: Key, color: 'text-blue-400', title: 'Timeout Handling', desc: 'Enforced timeout cutoff at 30 seconds to release pending event loops gracefully.' },
            { icon: Globe, color: 'text-emerald-400', title: 'CORS & Origin Whitelisting', desc: 'CORS requests verified against whitelisted app origins. Wildcard domains are strictly blocked.' },
          ].map(({ icon: Icon, color, title, desc }) => (
            <div key={title} className="flex items-start gap-3 py-3 border-t border-white/5 first:border-0">
              <Icon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${color}`} />
              <div>
                <p className="text-sm font-semibold text-white">{title}</p>
                <p className="text-xs text-zinc-500 mt-0.5 leading-relaxed">{desc}</p>
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* ══ CONTACT SALES ═════════════════════════════════════════════════ */}
      <div className="rounded-2xl border border-yellow-500/20 bg-gradient-to-br from-yellow-500/8 to-yellow-600/3 p-6 flex flex-col sm:flex-row items-start sm:items-center gap-4">
        <div className="w-11 h-11 rounded-2xl bg-yellow-500/15 border border-yellow-500/25 flex items-center justify-center flex-shrink-0">
          <Mail className="w-5 h-5 text-yellow-400" />
        </div>
        <div className="flex-1">
          <p className="text-sm font-bold text-white">Need higher limits or Enterprise access?</p>
          <p className="text-xs text-zinc-400 mt-0.5 leading-relaxed">
            Free tier is capped at 1,000 calls / month.
            Reach out to our sales team to discuss Growth or Enterprise plans with SLA, dedicated support, and custom quotas.
          </p>
        </div>
        <a
          id="api-docs-contact-sales"
          href="mailto:sales@gofriday.shop"
          className="flex-shrink-0 flex items-center gap-2 px-4 py-2.5 rounded-xl bg-yellow-500 text-black font-bold text-sm hover:bg-yellow-400 transition-colors shadow-lg shadow-yellow-500/20 active:scale-[0.98] whitespace-nowrap"
        >
          <Zap className="w-4 h-4" />
          Contact Sales
        </a>
      </div>

      <p className="text-center text-[10px] text-zinc-700 mt-8">
        Vroomie API v1 · Base URL: {BASE} · All requests require TLS
      </p>
    </div>
  );
}
