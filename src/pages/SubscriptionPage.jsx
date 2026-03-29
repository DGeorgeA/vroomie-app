import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { PLANS, generateUPILink, activateSubscription } from '../services/subscriptionService';
import { Crown, Zap, Check, Loader2, ExternalLink, ShieldCheck, Sparkles, ArrowLeft } from 'lucide-react';
import { toast } from 'sonner';

export default function SubscriptionPage() {
  const navigate = useNavigate();
  const { user, isPro, refreshSubscription } = useAuth();
  const [selectedPlan, setSelectedPlan] = useState(null);
  const [verifying, setVerifying] = useState(false);
  const [paymentInitiated, setPaymentInitiated] = useState(false);

  if (!user) {
    navigate('/login');
    return null;
  }

  if (isPro) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-zinc-950 via-zinc-900 to-black flex items-center justify-center p-4">
        <div className="text-center">
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-gradient-to-br from-yellow-400 to-amber-500 mb-6">
            <Crown className="w-10 h-10 text-black" />
          </div>
          <h1 className="text-2xl font-bold text-white mb-2">You're a Pro Member!</h1>
          <p className="text-gray-400 mb-6">All AI features are unlocked</p>
          <button
            onClick={() => navigate('/')}
            className="px-6 py-3 bg-gradient-to-r from-yellow-400 to-yellow-500 text-black font-semibold rounded-xl hover:from-yellow-300 hover:to-yellow-400 transition-all"
          >
            Back to Dashboard
          </button>
        </div>
      </div>
    );
  }

  const handlePayment = (planId) => {
    setSelectedPlan(planId);
    const upiLink = generateUPILink(planId);
    
    // Open UPI intent
    window.open(upiLink, '_blank');
    setPaymentInitiated(true);
    
    toast.info('Payment app opened. Complete payment, then verify below.');
  };

  const handleVerify = async () => {
    if (!selectedPlan) return;
    setVerifying(true);
    
    try {
      await activateSubscription(user.id, selectedPlan);
      await refreshSubscription();
      toast.success('🎉 Pro subscription activated!');
      navigate('/');
    } catch (err) {
      toast.error('Verification failed: ' + (err.message || 'Please try again'));
    } finally {
      setVerifying(false);
    }
  };

  const proFeatures = [
    'AI/ML Anomaly Detection Engine',
    'CNN Spectrogram Classifier',
    'Hybrid Fusion Analysis',
    'Advanced Diagnostic Reports',
    'Priority Voice Alerts',
    'Real-time Spectrogram View'
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-zinc-950 via-zinc-900 to-black p-4 pt-24">
      {/* Background glow */}
      <div className="absolute top-1/3 left-1/2 -translate-x-1/2 w-[500px] h-[500px] bg-yellow-400/5 rounded-full blur-[160px]" />

      <div className="relative max-w-4xl mx-auto">
        {/* Back */}
        <button
          onClick={() => navigate('/')}
          className="flex items-center gap-2 text-gray-400 hover:text-white transition-colors mb-8"
        >
          <ArrowLeft className="w-4 h-4" /> Back
        </button>

        {/* Header */}
        <div className="text-center mb-12">
          <div className="inline-flex items-center gap-2 bg-yellow-400/10 border border-yellow-400/20 rounded-full px-4 py-1.5 mb-4">
            <Sparkles className="w-4 h-4 text-yellow-400" />
            <span className="text-yellow-400 text-sm font-medium">Upgrade to Pro</span>
          </div>
          <h1 className="text-3xl md:text-4xl font-bold text-white mb-3">
            Unlock the Full <span className="bg-gradient-to-r from-yellow-300 to-yellow-500 bg-clip-text text-transparent">AI Engine</span>
          </h1>
          <p className="text-gray-400 max-w-lg mx-auto">
            Get enterprise-grade anomaly detection with CNN spectrogram analysis and hybrid fusion matching
          </p>
        </div>

        {/* Plan Cards */}
        <div className="grid md:grid-cols-2 gap-6 mb-12">
          {/* Monthly */}
          <div
            id="plan-monthly"
            className={`relative backdrop-blur-xl rounded-2xl p-6 border transition-all duration-300 cursor-pointer ${
              selectedPlan === 'monthly'
                ? 'bg-yellow-400/10 border-yellow-400/40 shadow-lg shadow-yellow-400/10'
                : 'bg-white/5 border-white/10 hover:border-white/20'
            }`}
            onClick={() => setSelectedPlan('monthly')}
          >
            <h3 className="text-lg font-bold text-white mb-1">Monthly</h3>
            <div className="flex items-baseline gap-1 mb-4">
              <span className="text-3xl font-bold text-yellow-400">₹100</span>
              <span className="text-gray-500">/month</span>
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); handlePayment('monthly'); }}
              className="w-full py-2.5 rounded-xl font-semibold text-sm bg-white/10 text-white hover:bg-white/15 border border-white/10 transition-all flex items-center justify-center gap-2"
            >
              <Zap className="w-4 h-4" /> Pay with UPI
            </button>
          </div>

          {/* Yearly */}
          <div
            id="plan-yearly"
            className={`relative backdrop-blur-xl rounded-2xl p-6 border transition-all duration-300 cursor-pointer ${
              selectedPlan === 'yearly'
                ? 'bg-yellow-400/10 border-yellow-400/40 shadow-lg shadow-yellow-400/10'
                : 'bg-white/5 border-white/10 hover:border-white/20'
            }`}
            onClick={() => setSelectedPlan('yearly')}
          >
            <div className="absolute -top-3 right-4 bg-gradient-to-r from-yellow-400 to-amber-500 text-black text-xs font-bold px-3 py-1 rounded-full">
              SAVE 42%
            </div>
            <h3 className="text-lg font-bold text-white mb-1">Yearly</h3>
            <div className="flex items-baseline gap-1 mb-1">
              <span className="text-3xl font-bold text-yellow-400">₹700</span>
              <span className="text-gray-500">/year</span>
            </div>
            <p className="text-xs text-gray-500 mb-4">≈ ₹58/month</p>
            <button
              onClick={(e) => { e.stopPropagation(); handlePayment('yearly'); }}
              className="w-full py-2.5 rounded-xl font-semibold text-sm bg-gradient-to-r from-yellow-400 to-yellow-500 text-black hover:from-yellow-300 hover:to-yellow-400 transition-all flex items-center justify-center gap-2 shadow-lg shadow-yellow-500/20"
            >
              <Crown className="w-4 h-4" /> Pay with UPI
            </button>
          </div>
        </div>

        {/* Verify Payment */}
        {paymentInitiated && (
          <div className="max-w-md mx-auto mb-12">
            <div className="backdrop-blur-xl bg-green-500/5 border border-green-500/20 rounded-2xl p-6 text-center">
              <ShieldCheck className="w-8 h-8 text-green-400 mx-auto mb-3" />
              <h3 className="text-white font-semibold mb-2">Payment Complete?</h3>
              <p className="text-gray-400 text-sm mb-4">
                After completing payment in your UPI app, tap below to activate your subscription.
              </p>
              <button
                id="verify-payment"
                onClick={handleVerify}
                disabled={verifying}
                className="w-full py-3 bg-gradient-to-r from-green-500 to-emerald-600 text-white font-semibold rounded-xl hover:from-green-400 hover:to-emerald-500 transition-all flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {verifying ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <><ShieldCheck className="w-4 h-4" /> Verify & Activate</>
                )}
              </button>
            </div>
          </div>
        )}

        {/* Feature List */}
        <div className="max-w-md mx-auto">
          <h3 className="text-sm text-gray-400 font-medium uppercase tracking-wider mb-4 text-center">
            What you get with Pro
          </h3>
          <div className="space-y-3">
            {proFeatures.map((feature, i) => (
              <div key={i} className="flex items-center gap-3">
                <div className="w-5 h-5 rounded-full bg-yellow-400/20 flex items-center justify-center shrink-0">
                  <Check className="w-3 h-3 text-yellow-400" />
                </div>
                <span className="text-gray-300 text-sm">{feature}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
