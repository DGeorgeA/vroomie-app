import{j as e,b as u}from"./framer-motion-Ce5Z33LB.js";import{C as b}from"./code-xml-BV-VEmNB.js";import{c,e as f,Z as m,A as w,M as N}from"./index-CdjcKmJE.js";import{R as v}from"./radio-Bi9NT16Q.js";import{T as h,C as z}from"./triangle-alert-CpeaNvpw.js";import{G as k}from"./globe-B9c47cPv.js";import{C as A}from"./chevron-right-om0JF-Al.js";import"./pdf-ZTolPqGc.js";import"./supabase-Cuj-a9Qj.js";/**
 * @license lucide-react v0.475.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const _=[["path",{d:"M18 6 7 17l-5-5",key:"116fxf"}],["path",{d:"m22 10-7.5 7.5L13 16",key:"ke71qq"}]],R=c("CheckCheck",_);/**
 * @license lucide-react v0.475.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const S=[["rect",{width:"14",height:"14",x:"8",y:"8",rx:"2",ry:"2",key:"17jyea"}],["path",{d:"M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2",key:"zix9uf"}]],T=c("Copy",S);/**
 * @license lucide-react v0.475.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const C=[["path",{d:"M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3",key:"1xhozi"}]],P=c("Headphones",C);/**
 * @license lucide-react v0.475.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const q=[["path",{d:"m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4",key:"g0fldk"}],["path",{d:"m21 2-9.6 9.6",key:"1j0ho8"}],["circle",{cx:"7.5",cy:"15.5",r:"5.5",key:"yqb3hr"}]],p=c("Key",q);/**
 * @license lucide-react v0.475.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const E=[["rect",{width:"14",height:"20",x:"5",y:"2",rx:"2",ry:"2",key:"1yt0o3"}],["path",{d:"M12 18h.01",key:"mhygvu"}]],I=c("Smartphone",E);/**
 * @license lucide-react v0.475.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const O=[["polyline",{points:"4 17 10 11 4 5",key:"akl6gq"}],["line",{x1:"12",x2:"20",y1:"19",y2:"19",key:"q2wloq"}]],B=c("Terminal",O);function n({title:s}){return e.jsx("h3",{className:"text-xs font-display font-bold text-zinc-500 uppercase tracking-widest mb-3 px-1",children:s})}function r({children:s,className:a=""}){return e.jsx("div",{className:`bg-zinc-900/60 border border-white/5 rounded-2xl overflow-hidden backdrop-blur-sm mb-6 ${a}`,children:s})}function t({code:s,language:a="bash",id:o}){const[i,l]=u.useState(!1),x=()=>{navigator.clipboard.writeText(s).then(()=>{l(!0),setTimeout(()=>l(!1),2e3)})};return e.jsxs("div",{className:"relative group rounded-xl bg-zinc-950 border border-white/8 overflow-hidden",children:[e.jsxs("div",{className:"flex items-center justify-between px-4 py-2 border-b border-white/5 bg-zinc-900/50",children:[e.jsx("span",{className:"text-[10px] font-mono font-bold text-zinc-500 uppercase tracking-widest",children:a}),e.jsxs("button",{id:`copy-${o}`,onClick:x,className:"flex items-center gap-1.5 text-[10px] text-zinc-500 hover:text-yellow-400 transition-colors",children:[i?e.jsx(R,{className:"w-3 h-3 text-emerald-400"}):e.jsx(T,{className:"w-3 h-3"}),i?"Copied!":"Copy"]})]}),e.jsx("pre",{className:"text-xs text-zinc-300 font-mono p-4 overflow-x-auto leading-relaxed whitespace-pre-wrap",children:s})]})}function d({method:s,path:a,description:o,children:i,id:l}){const[x,j]=u.useState(!1),g={POST:"bg-blue-500/15 text-blue-400 border-blue-500/25",GET:"bg-emerald-500/15 text-emerald-400 border-emerald-500/25",DELETE:"bg-red-500/15 text-red-400 border-red-500/25"};return e.jsxs("div",{className:"border-b border-white/5 last:border-0",children:[e.jsxs("button",{id:`endpoint-${l}`,onClick:()=>j(y=>!y),className:"w-full flex items-center gap-3 px-4 py-3.5 hover:bg-white/3 transition-colors text-left",children:[e.jsx("span",{className:`text-[10px] font-bold px-2 py-0.5 rounded border font-mono flex-shrink-0 ${g[s]||"bg-zinc-700 text-zinc-400 border-zinc-600"}`,children:s}),e.jsx("code",{className:"text-sm text-white font-mono flex-1",children:a}),e.jsx("span",{className:"text-xs text-zinc-500 hidden sm:block",children:o}),x?e.jsx(z,{className:"w-4 h-4 text-zinc-500 flex-shrink-0"}):e.jsx(A,{className:"w-4 h-4 text-zinc-500 flex-shrink-0"})]}),x&&e.jsx("div",{className:"px-4 pb-4 border-t border-white/5 bg-zinc-950/40 space-y-4 pt-4",children:i})]})}function V(){return e.jsxs("div",{className:"max-w-2xl mx-auto pb-16 w-full px-4",children:[e.jsx("div",{className:"mb-8 mt-4",children:e.jsxs("div",{className:"flex items-center gap-3 mb-2",children:[e.jsx("div",{className:"w-10 h-10 rounded-2xl bg-yellow-500/10 border border-yellow-500/20 flex items-center justify-center",children:e.jsx(b,{className:"w-5 h-5 text-yellow-400"})}),e.jsxs("div",{children:[e.jsx("h2",{className:"text-3xl font-display font-bold text-white tracking-tight",children:"API Docs"}),e.jsx("p",{className:"text-zinc-500 text-sm",children:"Integrate Vroomie's audio diagnostics into your own application."})]})]})}),e.jsx(n,{title:"Introduction"}),e.jsx(r,{children:e.jsxs("div",{className:"p-5 space-y-3",children:[e.jsx("p",{className:"text-sm text-zinc-300 leading-relaxed",children:"Vroomie APIs allow external applications to integrate real-time automotive anomaly detection and AI-assisted vehicle diagnostics into their own platforms."}),e.jsx("p",{className:"text-xs text-zinc-500 leading-relaxed",children:"Our state-of-the-art DSP and audio models run at high performance to analyze vehicle recording sessions, identify mechanical anomalies, and offer recommendations instantly."})]})}),e.jsx(n,{title:"Authentication"}),e.jsx(r,{children:e.jsxs("div",{className:"p-5 space-y-4",children:[e.jsxs("div",{className:"flex items-center gap-3",children:[e.jsx("div",{className:"w-9 h-9 rounded-xl bg-zinc-800/80 flex items-center justify-center text-purple-400 flex-shrink-0",children:e.jsx(p,{className:"w-4 h-4"})}),e.jsxs("div",{children:[e.jsx("p",{className:"text-sm font-medium text-white",children:"API Key — Bearer Token"}),e.jsx("p",{className:"text-xs text-zinc-500",children:"Pass your key in every request header."})]})]}),e.jsx("div",{className:"text-xs text-zinc-400 space-y-2",children:e.jsxs("p",{children:["To authenticate requests, generate an API key from the Vroomie Developer Portal, then supply it as a Bearer token in the ",e.jsx("code",{className:"text-yellow-400 bg-zinc-950 px-1 py-0.5 rounded",children:"Authorization"})," header."]})}),e.jsx(t,{id:"auth-header",language:"http",code:`Authorization: Bearer YOUR_API_KEY
Content-Type: application/json`})]})}),e.jsx(n,{title:"Core Endpoints"}),e.jsxs(r,{children:[e.jsx(d,{id:"analyze-audio",method:"POST",path:"/api/analyze-audio",description:"Submit vehicle audio for real-time anomaly detection",children:e.jsxs("div",{className:"space-y-3",children:[e.jsx("p",{className:"text-xs text-zinc-400",children:"Upload a Base64-encoded audio clip to analyze the audio engine or components for anomaly matching against our reference fingerprints."}),e.jsx("p",{className:"text-[10px] font-bold text-zinc-500 uppercase tracking-widest",children:"Request Payload"}),e.jsx(t,{id:"analyze-req",language:"json",code:`{
  "audio_b64": "UklGRiYAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=",
  "format": "wav",           // "wav" | "mp3" | "pcm"
  "sample_rate": 16000,
  "channels": 1,
  "sensitivity": "medium"   // "low" | "medium" | "high"
}`}),e.jsx("p",{className:"text-[10px] font-bold text-zinc-500 uppercase tracking-widest",children:"Response (200 OK)"}),e.jsx(t,{id:"analyze-res",language:"json",code:`{
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
}`})]})}),e.jsx(d,{id:"session-start",method:"POST",path:"/api/session/start",description:"Initialize a live diagnostics tracking session",children:e.jsxs("div",{className:"space-y-3",children:[e.jsx("p",{className:"text-xs text-zinc-400",children:"Starts a dynamic tracking session for streaming audio diagnostics. Returns a session ID."}),e.jsx("p",{className:"text-[10px] font-bold text-zinc-500 uppercase tracking-widest",children:"Request Payload"}),e.jsx(t,{id:"sess-start-req",language:"json",code:`{
  "device_id": "client_phone_001",
  "vehicle_meta": {
    "make": "Toyota",
    "model": "Corolla",
    "year": 2021
  }
}`}),e.jsx("p",{className:"text-[10px] font-bold text-zinc-500 uppercase tracking-widest",children:"Response (200 OK)"}),e.jsx(t,{id:"sess-start-res",language:"json",code:`{
  "session_id": "ses_9e8d7c6b5a",
  "status": "initialized",
  "started_at": "2026-05-17T12:05:00Z"
}`})]})}),e.jsx(d,{id:"session-stop",method:"POST",path:"/api/session/stop",description:"Complete and save the active diagnostics session",children:e.jsxs("div",{className:"space-y-3",children:[e.jsx("p",{className:"text-xs text-zinc-400",children:"Concludes the dynamic diagnostic session and generates a cumulative report."}),e.jsx("p",{className:"text-[10px] font-bold text-zinc-500 uppercase tracking-widest",children:"Request Payload"}),e.jsx(t,{id:"sess-stop-req",language:"json",code:`{
  "session_id": "ses_9e8d7c6b5a",
  "save_history": true
}`}),e.jsx("p",{className:"text-[10px] font-bold text-zinc-500 uppercase tracking-widest",children:"Response (200 OK)"}),e.jsx(t,{id:"sess-stop-res",language:"json",code:`{
  "session_id": "ses_9e8d7c6b5a",
  "status": "completed",
  "duration_ms": 15400,
  "total_anomalies_detected": 1,
  "report_summary": "Session ended cleanly. Minor engine tap identified."
}`})]})}),e.jsx(d,{id:"history",method:"GET",path:"/api/history",description:"Retrieve paginated diagnostics history logs",children:e.jsxs("div",{className:"space-y-3",children:[e.jsx("p",{className:"text-xs text-zinc-400",children:"Fetches all past diagnostic records associated with the authenticated developer account."}),e.jsx("p",{className:"text-[10px] font-bold text-zinc-500 uppercase tracking-widest",children:"Response (200 OK)"}),e.jsx(t,{id:"history-res",language:"json",code:`{
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
}`})]})}),e.jsx(d,{id:"health",method:"GET",path:"/api/health",description:"Check API server health status",children:e.jsxs("div",{className:"space-y-3",children:[e.jsx("p",{className:"text-xs text-zinc-400",children:"Returns the server availability, system status, and microservices health indicator."}),e.jsx("p",{className:"text-[10px] font-bold text-zinc-500 uppercase tracking-widest",children:"Response (200 OK)"}),e.jsx(t,{id:"health-res",language:"json",code:`{
  "status": "ok",
  "version": "1.0.0",
  "timestamp": "2026-05-17T12:10:00Z",
  "microservices": {
    "inference_engine": "healthy",
    "database": "healthy",
    "payment_gateway": "healthy"
  }
}`})]})})]}),e.jsx(n,{title:"Audio Requirements"}),e.jsx(r,{children:e.jsxs("div",{className:"p-5 space-y-4",children:[e.jsxs("div",{className:"flex items-center gap-3",children:[e.jsx("div",{className:"w-9 h-9 rounded-xl bg-zinc-800/80 flex items-center justify-center text-blue-400 flex-shrink-0",children:e.jsx(P,{className:"w-4 h-4"})}),e.jsxs("div",{children:[e.jsx("p",{className:"text-sm font-medium text-white",children:"Audio Formats & Signal Processing"}),e.jsx("p",{className:"text-xs text-zinc-500",children:"Requirements for high-accuracy anomaly detection."})]})]}),e.jsxs("div",{className:"grid grid-cols-2 gap-4",children:[e.jsxs("div",{className:"border border-white/5 rounded-xl p-3 bg-zinc-950/40",children:[e.jsx("p",{className:"text-xs font-bold text-zinc-400 uppercase tracking-wide mb-1",children:"Supported Formats"}),e.jsxs("ul",{className:"text-xs text-zinc-500 space-y-1 list-disc pl-4",children:[e.jsxs("li",{children:[e.jsx("strong",{className:"text-white",children:"WAV"})," (Standard PCM audio)"]}),e.jsxs("li",{children:[e.jsx("strong",{className:"text-white",children:"MP3"})," (Compressed audio streams)"]}),e.jsxs("li",{children:[e.jsx("strong",{className:"text-white",children:"PCM"})," (Raw sample streams)"]})]})]}),e.jsxs("div",{className:"border border-white/5 rounded-xl p-3 bg-zinc-950/40",children:[e.jsx("p",{className:"text-xs font-bold text-zinc-400 uppercase tracking-wide mb-1",children:"Recommended Specs"}),e.jsxs("ul",{className:"text-xs text-zinc-500 space-y-1 list-disc pl-4",children:[e.jsxs("li",{children:["Channels: ",e.jsx("strong",{className:"text-white",children:"mono"})," (1 channel)"]}),e.jsxs("li",{children:["Sample Rate: ",e.jsx("strong",{className:"text-white",children:"16kHz"})]}),e.jsxs("li",{children:["Duration: ",e.jsx("strong",{className:"text-white",children:"5 - 30 seconds"})]})]})]})]}),e.jsx("p",{className:"text-xs text-zinc-500 leading-relaxed",children:"Note: Multi-channel audio is downmixed to mono, and other sample rates are automatically resampled to 16kHz before processing, which can slightly increase latency. For fastest results, deliver 16kHz mono audio directly."})]})}),e.jsx(n,{title:"SDK / Integration Guide"}),e.jsx(r,{children:e.jsxs("div",{className:"p-5 space-y-4",children:[e.jsxs("div",{className:"space-y-2",children:[e.jsxs("div",{className:"flex items-center gap-2",children:[e.jsx(B,{className:"w-4 h-4 text-yellow-500"}),e.jsx("p",{className:"text-sm font-semibold text-white",children:"Web Browser Integration (JS/TS)"})]}),e.jsx("p",{className:"text-xs text-zinc-400",children:"Record microphone audio and submit it cleanly in vanilla Javascript:"}),e.jsx(t,{id:"js-sdk",language:"javascript",code:`const mediaRecorder = new MediaRecorder(stream);
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
};`})]}),e.jsxs("div",{className:"space-y-2 pt-2 border-t border-white/5",children:[e.jsxs("div",{className:"flex items-center gap-2",children:[e.jsx(I,{className:"w-4 h-4 text-cyan-400"}),e.jsx("p",{className:"text-sm font-semibold text-white",children:"Mobile Integration (iOS / Android)"})]}),e.jsx("p",{className:"text-xs text-zinc-400",children:"For iOS (Swift) and Android (Kotlin), record audio using native audio pipelines, convert to standard WAV mono at 16000Hz, encode as Base64, and transmit."})]}),e.jsxs("div",{className:"space-y-2 pt-2 border-t border-white/5",children:[e.jsxs("div",{className:"flex items-center gap-2",children:[e.jsx(v,{className:"w-4 h-4 text-purple-400"}),e.jsx("p",{className:"text-sm font-semibold text-white",children:"Streaming Audio Support"})]}),e.jsxs("p",{className:"text-xs text-zinc-400",children:["Websocket pipelines are available for active, low-latency analysis of vehicle sounds. Establish a secure socket connection at ",e.jsx("code",{className:"text-yellow-400 bg-zinc-950 px-1 py-0.5 rounded",children:"wss://api.vroomie.in/v1/stream"})," and pipe PCM binary frames directly."]})]})]})}),e.jsx(n,{title:"Rate Limits & API Guardrails"}),e.jsx(r,{children:e.jsxs("div",{className:"p-5 space-y-4",children:[e.jsxs("div",{className:"border border-white/8 bg-zinc-950/60 rounded-xl p-4 space-y-3",children:[e.jsx("p",{className:"text-xs font-bold text-zinc-500 uppercase tracking-widest",children:"Free Plan Allowance"}),e.jsxs("div",{className:"text-sm text-zinc-300 font-semibold space-y-1",children:[e.jsx("p",{className:"text-yellow-400 text-lg",children:"FREE PLAN:"}),e.jsx("p",{children:"• 100 API calls/day"}),e.jsx("p",{children:"OR"}),e.jsx("p",{children:"• 1,000 API calls/month"})]}),e.jsxs("div",{className:"text-xs text-zinc-500 leading-relaxed border-t border-white/5 pt-3",children:[e.jsx("span",{className:"text-red-400 font-semibold",children:"AFTER LIMIT:"}),e.jsx("br",{}),'"Please contact ',e.jsx("a",{href:"mailto:sales@gofriday.shop",className:"text-yellow-400 hover:underline",children:"sales@gofriday.shop"}),' for extended access."']})]}),e.jsxs("div",{className:"flex items-start gap-3 p-3 rounded-xl border border-yellow-500/20 bg-yellow-500/5",children:[e.jsx(h,{className:"w-4 h-4 text-yellow-400 flex-shrink-0 mt-0.5"}),e.jsxs("p",{className:"text-xs text-zinc-400 leading-relaxed",children:["Exceeded calls will trigger ",e.jsx("code",{className:"text-yellow-400 text-[11px] bg-yellow-500/10 px-1 rounded",children:"HTTP 429 Too Many Requests"}),". Throttling guardrails include a strict 10 requests per minute burst limit."]})]})]})}),e.jsx(n,{title:"Platform Security & Guardrails"}),e.jsx(r,{children:e.jsxs("div",{className:"p-5 space-y-3",children:[e.jsxs("div",{className:"flex items-center gap-3 mb-2",children:[e.jsx("div",{className:"w-9 h-9 rounded-xl bg-zinc-800/80 flex items-center justify-center text-red-400 flex-shrink-0",children:e.jsx(w,{className:"w-4 h-4"})}),e.jsx("p",{className:"text-sm font-medium text-white",children:"Production Guardrail Metrics"})]}),[{icon:f,color:"text-purple-400",title:"HTTPS Only",desc:"All API traffic must use TLS 1.2+. HTTP requests are rejected with a 400 Bad Request."},{icon:m,color:"text-yellow-400",title:"Request Throttling & Rate Limiting",desc:"Protected by our active express middleware with in-memory bucket token rate limits."},{icon:h,color:"text-orange-400",title:"Payload Size Limits",desc:"Audio uploads are capped at 5 MB maximum size to prevent abuse and buffer overrun."},{icon:p,color:"text-blue-400",title:"Timeout Handling",desc:"Enforced timeout cutoff at 30 seconds to release pending event loops gracefully."},{icon:k,color:"text-emerald-400",title:"CORS & Origin Whitelisting",desc:"CORS requests verified against whitelisted app origins. Wildcard domains are strictly blocked."}].map(({icon:a,color:o,title:i,desc:l})=>e.jsxs("div",{className:"flex items-start gap-3 py-3 border-t border-white/5 first:border-0",children:[e.jsx(a,{className:`w-4 h-4 mt-0.5 flex-shrink-0 ${o}`}),e.jsxs("div",{children:[e.jsx("p",{className:"text-sm font-semibold text-white",children:i}),e.jsx("p",{className:"text-xs text-zinc-500 mt-0.5 leading-relaxed",children:l})]})]},i))]})}),e.jsxs("div",{className:"rounded-2xl border border-yellow-500/20 bg-gradient-to-br from-yellow-500/8 to-yellow-600/3 p-6 flex flex-col sm:flex-row items-start sm:items-center gap-4",children:[e.jsx("div",{className:"w-11 h-11 rounded-2xl bg-yellow-500/15 border border-yellow-500/25 flex items-center justify-center flex-shrink-0",children:e.jsx(N,{className:"w-5 h-5 text-yellow-400"})}),e.jsxs("div",{className:"flex-1",children:[e.jsx("p",{className:"text-sm font-bold text-white",children:"Need higher limits or Enterprise access?"}),e.jsx("p",{className:"text-xs text-zinc-400 mt-0.5 leading-relaxed",children:"Free tier is capped at 1,000 calls / month. Reach out to our sales team to discuss Growth or Enterprise plans with SLA, dedicated support, and custom quotas."})]}),e.jsxs("a",{id:"api-docs-contact-sales",href:"mailto:sales@gofriday.shop",className:"flex-shrink-0 flex items-center gap-2 px-4 py-2.5 rounded-xl bg-yellow-500 text-black font-bold text-sm hover:bg-yellow-400 transition-colors shadow-lg shadow-yellow-500/20 active:scale-[0.98] whitespace-nowrap",children:[e.jsx(m,{className:"w-4 h-4"}),"Contact Sales"]})]}),e.jsxs("p",{className:"text-center text-[10px] text-zinc-700 mt-8",children:["Vroomie API v1 · Base URL: ","https://api.vroomie.in/v1"," · All requests require TLS"]})]})}export{V as default};
