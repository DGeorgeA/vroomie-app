import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { PLANS, generateUPILink, activateSubscription } from '../services/subscriptionService';
import { openRazorpayCheckout } from '../services/paymentService';
import { Crown, Zap, Check, Loader2, ShieldCheck, Sparkles, ArrowLeft, CreditCard } from 'lucide-react';
import { toast } from 'sonner';

export default function SubscriptionPage() {
  const navigate = useNavigate();
  const { user, isPro, refreshSubscription } = useAuth();
  const [selectedPlan, setSelectedPlan] = useState(null);
  const [verifying, setVerifying] = useState(false);
  const [loadingRazorpay, setLoadingRazorpay] = useState(false);
  const [paymentInitiated, setPaymentInitiated] = useState(false);

  if (!user) {
    navigate('/login');
    return null;
  }

  if (isPro) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-zinc-950 via-zinc-900 to-black flex items-center justify-center p-4">
        <div className="text-center relative z-10">
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-gradient-to-br from-yellow-400 to-amber-500 mb-6 shadow-xl shadow-yellow-500/20">
            <Crown className="w-10 h-10 text-black" />
          </div>
          <h1 className="text-2xl font-bold text-white mb-2">You're a Pro Member!</h1>
          <p className="text-gray-400 mb-6">All AI features and public APIs are fully unlocked.</p>
          <button
            onClick={() => navigate('/')}
            className="px-6 py-3 bg-gradient-to-r from-yellow-400 to-yellow-500 text-black font-semibold rounded-xl hover:from-yellow-300 hover:to-yellow-400 transition-all active:scale-[0.98]"
          >
            Back to Dashboard
          </button>
        </div>
      </div>
    );
  }

  const handleRazorpayPayment = async (planId) => {
    setSelectedPlan(planId);
    setLoadingRazorpay(true);
    
    // Map plans to matches
    const rzpPlanMap = {
      monthly: 'AI_ENABLED_MONTHLY',
      yearly: 'AI_ENABLED_YEARLY'
    };
    
    const mappedPlan = rzpPlanMap[planId];
    
    try {
      await openRazorpayCheckout({
        planId: mappedPlan,
        userId: user.id,
        userEmail: user.email,
        onSuccess: async (verificationResult) => {
          toast.success('🎉 Razorpay Payment Verified & Activated!');
          await refreshSubscription();
          navigate('/');
        },
        onFailure: (error) => {
          toast.error(`Checkout failed: ${error.message || 'Please try again.'}`);
        }
      });
    } catch (err) {
      toast.error('Could not initialize checkout. Falling back to UPI...');
      // Fallback
      handleUpiPayment(planId);
    } finally {
      setLoadingRazorpay(false);
    }
  };

  const handleUpiPayment = (planId) => {
    setSelectedPlan(planId);
    const upiLink = generateUPILink(planId);
    
    // Open UPI intent
    window.open(upiLink, '_blank');
    setPaymentInitiated(true);
    
    toast.info('Payment app opened. Complete payment, then verify below.');
  };

  const handleUpiVerify = async () => {
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
    'Real-time Spectrogram View',
    'Public API & Webhook Integration access'
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-zinc-950 via-zinc-900 to-black p-4 pt-24 relative overflow-hidden">
      {/* Background glow */}
      <div className="absolute top-1/3 left-1/2 -translate-x-1/2 w-[500px] h-[500px] bg-yellow-400/5 rounded-full blur-[160px] pointer-events-none" />

      <div className="relative max-w-4xl mx-auto z-10">
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
            Get enterprise-grade anomaly detection with CNN spectrogram analysis, hybrid fusion matching, and Developer API access.
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
            <h3 className="text-lg font-bold text-white mb-1">Monthly Pro</h3>
            <div className="flex items-baseline gap-1 mb-4">
              <span className="text-3xl font-bold text-yellow-400">₹100</span>
              <span className="text-gray-500">/month</span>
            </div>
            
            <div className="space-y-2 mt-4">
              <button
                onClick={(e) => { e.stopPropagation(); handleRazorpayPayment('monthly'); }}
                disabled={loadingRazorpay && selectedPlan === 'monthly'}
                className="w-full py-2.5 rounded-xl font-semibold text-sm bg-yellow-500 text-black hover:bg-yellow-400 transition-all flex items-center justify-center gap-2 active:scale-[0.98]"
              >
                {loadingRazorpay && selectedPlan === 'monthly' ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <CreditCard className="w-4 h-4" />
                )}
                Pay with Razorpay / Cards
              </button>
              
              <button
                onClick={(e) => { e.stopPropagation(); handleUpiPayment('monthly'); }}
                className="w-full py-2 rounded-xl font-semibold text-xs bg-white/5 text-zinc-300 hover:bg-white/10 border border-white/5 transition-all flex items-center justify-center gap-2"
              >
                <Zap className="w-3 h-3" /> Fallback: Pay with UPI App
              </button>
            </div>
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
            <div className="absolute -top-3 right-4 bg-gradient-to-r from-yellow-400 to-amber-500 text-black text-xs font-bold px-3 py-1 rounded-full shadow-md">
              SAVE 42%
            </div>
            <h3 className="text-lg font-bold text-white mb-1">Yearly Pro</h3>
            <div className="flex items-baseline gap-1 mb-1">
              <span className="text-3xl font-bold text-yellow-400">₹700</span>
              <span className="text-gray-500">/year</span>
            </div>
            <p className="text-xs text-gray-500 mb-4">≈ ₹58/month</p>
            
            <div className="space-y-2">
              <button
                onClick={(e) => { e.stopPropagation(); handleRazorpayPayment('yearly'); }}
                disabled={loadingRazorpay && selectedPlan === 'yearly'}
                className="w-full py-2.5 rounded-xl font-semibold text-sm bg-gradient-to-r from-yellow-400 to-yellow-500 text-black hover:from-yellow-300 hover:to-yellow-400 transition-all flex items-center justify-center gap-2 shadow-lg shadow-yellow-500/20 active:scale-[0.98]"
              >
                {loadingRazorpay && selectedPlan === 'yearly' ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Crown className="w-4 h-4" />
                )}
                Pay with Razorpay / Cards
              </button>
              
              <button
                onClick={(e) => { e.stopPropagation(); handleUpiPayment('yearly'); }}
                className="w-full py-2 rounded-xl font-semibold text-xs bg-white/5 text-zinc-300 hover:bg-white/10 border border-white/5 transition-all flex items-center justify-center gap-2"
              >
                <Zap className="w-3 h-3" /> Fallback: Pay with UPI App
              </button>
            </div>
          </div>
        </div>

        {/* Verify UPI Payment */}
        {paymentInitiated && (
          <div className="max-w-md mx-auto mb-12">
            <div className="backdrop-blur-xl bg-green-500/5 border border-green-500/20 rounded-2xl p-6 text-center shadow-lg shadow-green-500/5">
              <ShieldCheck className="w-8 h-8 text-green-400 mx-auto mb-3" />
              <h3 className="text-white font-semibold mb-2">Payment Complete?</h3>
              <p className="text-gray-400 text-sm mb-4">
                After completing payment in your UPI app, tap below to activate your subscription.
              </p>
              <button
                id="verify-payment"
                onClick={handleUpiVerify}
                disabled={verifying}
                className="w-full py-3 bg-gradient-to-r from-green-500 to-emerald-600 text-white font-semibold rounded-xl hover:from-green-400 hover:to-emerald-500 transition-all flex items-center justify-center gap-2 disabled:opacity-50 active:scale-[0.98]"
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
