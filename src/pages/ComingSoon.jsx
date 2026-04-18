import React from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Rocket, ArrowLeft } from 'lucide-react';

export default function ComingSoon({ featureName = 'This feature' }) {
  const navigate = useNavigate();
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] px-6 text-center">
      <motion.div
        initial={{ opacity: 0, scale: 0.88 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        className="max-w-md"
      >
        <div className="w-20 h-20 rounded-3xl bg-yellow-500/10 border border-yellow-500/20 flex items-center justify-center mx-auto mb-8">
          <Rocket className="w-9 h-9 text-yellow-400" />
        </div>

        <h1 className="text-3xl font-display font-bold text-white mb-3">{featureName}</h1>

        <p className="text-zinc-400 text-sm leading-relaxed mb-8">
          This capability is currently in development and will be introduced shortly as part of Vroomie's
          next evolution — built to deliver a premium, deeply integrated experience.
        </p>

        <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-yellow-500/20 bg-yellow-500/5 text-yellow-400 text-xs font-semibold mb-8">
          <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" />
          Being crafted with precision
        </div>

        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <button
            onClick={() => navigate('/')}
            className="flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-white text-sm font-medium transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Dashboard
          </button>
        </div>
      </motion.div>
    </div>
  );
}
