import React from 'react';
import { motion } from 'framer-motion';
import {
  Cpu, Mic, Activity, Zap, Layers,
  ShieldCheck, Radio, TrendingUp, ChevronRight
} from 'lucide-react';

const fadeUp = (delay = 0) => ({
  initial: { opacity: 0, y: 24 },
  animate: { opacity: 1, y: 0 },
  transition: { delay, duration: 0.45, ease: [0.22, 1, 0.36, 1] },
});

const CAPABILITIES = [
  { icon: Mic,        label: 'Real-time engine audio capture',            status: 'live' },
  { icon: Activity,   label: 'Pattern-based spectral anomaly matching',   status: 'live' },
  { icon: Cpu,        label: 'Belt, piston, and bearing fault detection', status: 'live' },
  { icon: ShieldCheck,label: 'Confidence-gated false-positive rejection', status: 'live' },
  { icon: Zap,        label: 'Voice-alert feedback after diagnostics',    status: 'live' },
];

const UPCOMING = [
  {
    icon: Cpu,
    title: 'EV & Hybrid Diagnostics',
    desc: 'Advanced AI models designed to analyse electric motor acoustics, battery management sounds, and hybrid drivetrain behaviour.',
  },
  {
    icon: Layers,
    title: 'Continuous Learning Models',
    desc: 'Detection accuracy improves automatically as the system learns from anonymised patterns contributed by the Vroomie community.',
  },
  {
    icon: Radio,
    title: 'AI Pre-Purchase Inspection',
    desc: 'Scan a used vehicle before you buy. AI flags hidden mechanical issues that standard visual inspections miss.',
  },
  {
    icon: TrendingUp,
    title: 'Predictive Maintenance Schedules',
    desc: 'Based on your vehicle\'s acoustic fingerprint over time, Vroomie will predict when components are likely to fail — before they do.',
  },
];

export default function AIUpdates() {
  return (
    <div className="max-w-3xl mx-auto pb-16 w-full">

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <motion.div {...fadeUp(0)} className="mb-12 px-1">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-yellow-500/10 border border-yellow-500/20 text-yellow-400 text-xs font-semibold mb-4">
          <Zap className="w-3.5 h-3.5" />
          AI Platform Updates
        </div>
        <h1 className="text-4xl md:text-5xl font-display font-bold text-white tracking-tight leading-tight mb-4">
          The{' '}
          <span className="bg-gradient-to-r from-yellow-300 via-yellow-100 to-white bg-clip-text text-transparent">
            Intelligence
          </span>{' '}
          Behind Vroomie
        </h1>
        <p className="text-zinc-400 text-base md:text-lg leading-relaxed max-w-2xl">
          Vroomie listens to your engine and analyses audio patterns in real time to identify early signs of
          mechanical issues. By comparing your engine's sound against trained acoustic signatures, it helps
          detect anomalies before they become serious — and costly — problems.
        </p>
      </motion.div>

      {/* ── How It Works ─────────────────────────────────────────────────── */}
      <motion.div {...fadeUp(0.05)} className="mb-12">
        <h2 className="text-xl font-display font-bold text-white mb-5">How It Works</h2>
        <div className="grid md:grid-cols-3 gap-4">
          {[
            { step: '01', title: 'Listen',  body: 'Your microphone captures engine audio in real time. No cloud upload — processing runs entirely in your browser.' },
            { step: '02', title: 'Analyse', body: 'AI extracts 42-dimensional acoustic feature vectors from the signal and compares them against trained reference signatures.' },
            { step: '03', title: 'Alert',   body: 'When a confirmed pattern match crosses the confidence threshold, Vroomie raises an immediate visual and voice alert.' },
          ].map(({ step, title, body }) => (
            <div key={step} className="bg-zinc-900/60 border border-white/5 rounded-2xl p-5 backdrop-blur-sm">
              <span className="text-4xl font-display font-bold text-yellow-500/20 leading-none">{step}</span>
              <h3 className="text-base font-bold text-white mt-2 mb-1">{title}</h3>
              <p className="text-xs text-zinc-400 leading-relaxed">{body}</p>
            </div>
          ))}
        </div>
      </motion.div>

      {/* ── Current Capabilities ─────────────────────────────────────────── */}
      <motion.div {...fadeUp(0.1)} className="mb-12">
        <h2 className="text-xl font-display font-bold text-white mb-1">Current Capabilities</h2>
        <p className="text-zinc-500 text-sm mb-5">Live in production today.</p>
        <div className="bg-zinc-900/60 border border-white/5 rounded-2xl overflow-hidden">
          {CAPABILITIES.map((cap, i) => (
            <div
              key={cap.label}
              className={`flex items-center gap-4 px-5 py-3.5 ${i < CAPABILITIES.length - 1 ? 'border-b border-white/5' : ''}`}
            >
              <div className="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center flex-shrink-0">
                <cap.icon className="w-4 h-4 text-emerald-400" />
              </div>
              <span className="text-sm text-zinc-300 flex-1">{cap.label}</span>
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                LIVE
              </span>
            </div>
          ))}
        </div>
      </motion.div>

      {/* ── Coming Next ──────────────────────────────────────────────────── */}
      <motion.div {...fadeUp(0.15)}>
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-xl font-display font-bold text-white">What's Coming Next</h2>
          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/20">
            ROADMAP
          </span>
        </div>
        <p className="text-zinc-500 text-sm mb-5">
          Vroomie is evolving into a full-spectrum AI diagnostic platform. These capabilities are being
          fine-tuned to deliver deeper, more reliable insights across all vehicle types.
        </p>

        <div className="grid md:grid-cols-2 gap-4">
          {UPCOMING.map(({ icon: Icon, title, desc }) => (
            <div
              key={title}
              className="group bg-zinc-900/60 border border-white/5 hover:border-yellow-500/20 rounded-2xl p-5 backdrop-blur-sm transition-all duration-300 hover:bg-zinc-900/80"
            >
              <div className="w-10 h-10 rounded-xl bg-yellow-500/10 border border-yellow-500/15 flex items-center justify-center mb-4">
                <Icon className="w-5 h-5 text-yellow-400" />
              </div>
              <h3 className="text-sm font-bold text-white mb-1.5">{title}</h3>
              <p className="text-xs text-zinc-400 leading-relaxed">{desc}</p>
              <div className="mt-4 flex items-center gap-1 text-[10px] font-semibold text-yellow-500/60 group-hover:text-yellow-400 transition-colors">
                In development <ChevronRight className="w-3 h-3" />
              </div>
            </div>
          ))}
        </div>

        <div className="mt-8 p-5 rounded-2xl bg-gradient-to-br from-yellow-500/5 to-transparent border border-yellow-500/10">
          <p className="text-sm text-zinc-400 leading-relaxed">
            "These capabilities are being fine-tuned to deliver deeper, more reliable insights across all
            vehicle types — from conventional combustion engines to next-generation electric drivetrains."
          </p>
          <p className="text-xs text-zinc-600 mt-2">— Vroomie AI Research Team</p>
        </div>
      </motion.div>
    </div>
  );
}
