import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Zap, ArrowRight, Lock } from 'lucide-react';

export default function UpgradeBanner({ compact = false }) {
  const navigate = useNavigate();

  if (compact) {
    return (
      <button
        id="upgrade-banner-compact"
        onClick={() => navigate('/subscribe')}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-gradient-to-r from-yellow-400/20 to-amber-500/20 border border-yellow-400/30 text-yellow-400 hover:from-yellow-400/30 hover:to-amber-500/30 transition-all"
      >
        <Lock className="w-3 h-3" />
        Upgrade to Pro
      </button>
    );
  }

  return (
    <div
      id="upgrade-banner"
      className="relative overflow-hidden backdrop-blur-xl bg-gradient-to-r from-yellow-400/10 via-amber-500/10 to-yellow-400/10 border border-yellow-400/20 rounded-2xl p-5 cursor-pointer hover:border-yellow-400/40 transition-all group"
      onClick={() => navigate('/subscribe')}
    >
      {/* Shimmer */}
      <div className="absolute inset-0 bg-gradient-to-r from-transparent via-yellow-400/5 to-transparent translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-1000" />

      <div className="relative flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-yellow-400 to-amber-500 flex items-center justify-center shadow-lg shadow-yellow-500/20">
            <Zap className="w-5 h-5 text-black" />
          </div>
          <div>
            <h3 className="text-white font-semibold text-sm">Upgrade to AI Engine</h3>
            <p className="text-gray-400 text-xs">
              Unlock CNN classifier, spectrogram analysis & more
            </p>
          </div>
        </div>
        <ArrowRight className="w-5 h-5 text-yellow-400 group-hover:translate-x-1 transition-transform" />
      </div>
    </div>
  );
}
