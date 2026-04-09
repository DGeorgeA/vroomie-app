import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Shield, Zap, Clock } from 'lucide-react';
import VroomieLogo from '@/components/ui/VroomieLogo';

export default function AuthPanel() {
  const navigate = useNavigate();

  return (
    <div className="hidden lg:flex flex-col justify-between fixed left-0 top-0 bottom-0 w-[400px] bg-zinc-950 border-r border-white/5 p-12 z-40">
      <div>
        <div className="flex items-center gap-3 mb-16">
          <VroomieLogo size="lg" />
          <span className="text-2xl font-bold bg-gradient-to-r from-yellow-200 to-yellow-600 bg-clip-text text-transparent italic tracking-tight">
            Vroomie
          </span>
        </div>
        
        <h2 className="text-3xl font-medium text-white mb-6 leading-tight">
          Unlock Predictive Diagnostics.
        </h2>
        <p className="text-zinc-400 text-lg mb-12">
          Join thousands of drivers identifying engine faults before they become expensive breakdowns.
        </p>

        <div className="space-y-6">
          <Feature icon={Shield} title="Bank-grade Security" desc="Your vehicle data is fully encrypted." />
          <Feature icon={Zap} title="AI-Powered" desc="Trained on millions of acoustic engine signatures." />
          <Feature icon={Clock} title="Real-time Metrics" desc="Instant analysis and actionable insights." />
        </div>
      </div>

      <div className="pt-8 border-t border-white/5">
        <button
          onClick={() => navigate('/login')}
          className="w-full py-4 rounded-xl bg-yellow-500 text-black font-bold text-lg hover:bg-yellow-400 transition-all shadow-[0_0_20px_rgba(234,179,8,0.2)] hover:shadow-[0_0_30px_rgba(234,179,8,0.4)] hover:-translate-y-0.5"
        >
          Sign In / Create Account
        </button>
      </div>
    </div>
  );
}

function Feature({ icon: Icon, title, desc }) {
  return (
    <div className="flex gap-4">
      <div className="w-10 h-10 rounded-full bg-yellow-500/10 flex items-center justify-center flex-shrink-0">
        <Icon className="w-5 h-5 text-yellow-500" />
      </div>
      <div>
        <h4 className="text-white font-medium">{title}</h4>
        <p className="text-zinc-500 text-sm mt-1">{desc}</p>
      </div>
    </div>
  );
}
