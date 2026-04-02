import React from "react";
import { motion } from "framer-motion";
import { Zap, ArrowRight } from "lucide-react";
import GlassButton from "../ui/GlassButton";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";

export default function Hero() {
  return (
    <div className="relative min-h-screen flex items-center justify-center overflow-hidden">
      {/* Static ambient background — no infinite animations */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 -left-32 w-96 h-96 bg-yellow-300/8 rounded-full blur-3xl" />
        <div className="absolute bottom-1/4 -right-32 w-96 h-96 bg-yellow-500/8 rounded-full blur-3xl" />
      </div>

      {/* Content */}
      <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-20 text-center">
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="mb-6"
        >
          <div className="inline-flex items-center gap-2 bg-yellow-300/10 border border-yellow-300/25 rounded-full px-4 py-2 mb-8">
            <Zap className="w-3.5 h-3.5 text-yellow-300" />
            <span className="text-yellow-300 text-sm font-medium">AI-Powered Car Diagnostics</span>
          </div>
        </motion.div>

        <motion.h1
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.15 }}
          className="text-5xl md:text-7xl lg:text-8xl font-bold mb-6 leading-tight"
        >
          <span className="bg-gradient-to-r from-white via-yellow-100 to-yellow-300 bg-clip-text text-transparent">
            Your Car's
          </span>
          <br />
          <span className="bg-gradient-to-r from-yellow-300 to-yellow-500 bg-clip-text text-transparent">
            AI Copilot
          </span>
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.3 }}
          className="text-lg md:text-xl text-zinc-400 mb-12 max-w-2xl mx-auto leading-relaxed"
        >
          Predict maintenance issues before they happen. Detect engine anomalies in real time with AI audio analysis.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.45 }}
          className="flex justify-center items-center"
        >
          <Link to={createPageUrl("PredictiveMaintenance")}>
            <GlassButton size="lg" icon={ArrowRight}>
              Start Diagnosis
            </GlassButton>
          </Link>
        </motion.div>

        {/* Stats */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.6 }}
          className="mt-20 grid grid-cols-3 gap-6 max-w-2xl mx-auto"
        >
          {[
            { value: "99.8%", label: "Accuracy" },
            { value: "24/7", label: "Monitoring" },
            { value: "< 5 min", label: "Setup Time" },
          ].map((stat, index) => (
            <div key={index} className="bg-white/4 border border-white/8 rounded-xl p-5">
              <div className="text-2xl md:text-3xl font-bold text-yellow-300 mb-1">
                {stat.value}
              </div>
              <div className="text-zinc-500 text-xs font-medium uppercase tracking-wider">{stat.label}</div>
            </div>
          ))}
        </motion.div>
      </div>

      {/* Scroll indicator */}
      <motion.div
        animate={{ y: [0, 8, 0] }}
        transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
        className="absolute bottom-8 left-1/2 -translate-x-1/2"
      >
        <div className="w-5 h-8 border border-white/20 rounded-full flex items-start justify-center p-1.5">
          <div className="w-1 h-2 bg-white/30 rounded-full" />
        </div>
      </motion.div>
    </div>
  );
}