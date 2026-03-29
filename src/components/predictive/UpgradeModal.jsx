import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Sparkles, Check, Loader2, QrCode } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { startFreeTrial } from '@/services/subscriptionService';
import { toast } from 'sonner';
import { ErrorBoundary } from '../ErrorBoundary';

function UpgradeModalContent({ isOpen, onClose }) {
  const [loading, setLoading] = useState(false);
  const [paymentFallback, setPaymentFallback] = useState(false);
  const { user, refreshSubscription } = useAuth();
  const navigate = useNavigate();

  const handleStartTrial = async () => {
    if (!user) {
      navigate('/login');
      return;
    }
    
    setLoading(true);
    try {
      await startFreeTrial(user.id);
      await refreshSubscription();
      toast.success('🎉 3-Day Free Trial Activated! AI Engine Unlocked.');
      onClose();
    } catch (err) {
      console.error(err);
      toast.error('Could not activate trial. Try again later.');
    } finally {
      setLoading(false);
    }
  };

  const handlePayment = (planId, amount) => {
    try {
      if (!user) {
        navigate('/login');
        return;
      }
      
      console.log("Initiating payment for", planId);
      
      const upiId = 'vroomie@ybl'; // Replace with actual UPI ID
      const upiUrl = `upi://pay?pa=${upiId}&pn=Vroomie&am=${amount}&cu=INR&tn=Vroomie Pro ${planId}`;
      
      // Attempt to open UPI Intent
      window.location.href = upiUrl;
      
      // Fallback in case window.location.href fails silently (e.g. desktop)
      setTimeout(() => {
        setPaymentFallback(true);
        toast.info("If UPI didn't open automatically, you can scan via web.");
      }, 1500);

    } catch (error) {
      console.error("Payment trigger failed:", error);
      setPaymentFallback(true);
    }
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
          {/* Backdrop */}
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 bg-black/60 backdrop-blur-md" 
            onClick={onClose}
          />
          
          {/* Modal Content */}
          <motion.div 
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
            className="relative w-full max-w-md bg-zinc-950 border border-white/10 rounded-3xl shadow-2xl overflow-hidden"
          >
            {/* Animated border gradient */}
            <div className="absolute inset-0 bg-gradient-to-br from-cyan-500/20 via-transparent to-amber-500/20 pointer-events-none" />
            
            {/* Header Glow */}
            <div className="absolute top-0 inset-x-0 h-40 bg-gradient-to-b from-cyan-500/10 to-transparent pointer-events-none" />
            
            <button 
              onClick={onClose}
              className="absolute top-4 right-4 z-10 p-2 text-gray-400 hover:text-white hover:bg-white/5 rounded-full transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
            
            <div className="p-8 pb-6 relative z-10">
              <motion.div 
                initial={{ scale: 0.8, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ delay: 0.1, type: "spring" }}
                className="w-16 h-16 rounded-2xl bg-gradient-to-br from-cyan-400/20 to-blue-600/20 border border-cyan-400/30 flex items-center justify-center mb-6 shadow-lg shadow-cyan-500/20"
              >
                 <Sparkles className="w-8 h-8 text-cyan-400 animate-pulse" />
              </motion.div>
              
              <h2 className="text-2xl font-bold text-white mb-2 tracking-tight">Unlock AI Engine</h2>
              <p className="text-gray-400 text-sm mb-6 leading-relaxed">
                Experience the future of predictive diagnostics. Powered by advanced Spectrogram CNNs and Hybrid Flow intelligence.
              </p>
              
              {/* Features List */}
              <div className="space-y-3 mb-8">
                {[
                  'CNN Spectrogram Classifier',
                  'Hyper-precise Hybrid Fusion',
                  'Advanced Noise Cancellation',
                  'Zero-Latency Processing'
                ].map((ft, i) => (
                  <motion.div 
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.2 + (i * 0.05) }}
                    key={i} 
                    className="flex items-center gap-3"
                  >
                    <div className="w-5 h-5 rounded-full bg-cyan-400/10 flex items-center justify-center shrink-0">
                      <Check className="w-3 h-3 text-cyan-400" />
                    </div>
                    <span className="text-gray-300 text-sm font-medium">{ft}</span>
                  </motion.div>
                ))}
              </div>
              
              {/* Actions */}
              <div className="space-y-3">
                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={handleStartTrial}
                  disabled={loading}
                  className="relative group w-full py-3.5 rounded-xl font-bold bg-gradient-to-r from-cyan-500 to-blue-600 text-white shadow-[0_0_20px_rgba(6,182,212,0.3)] hover:shadow-[0_0_30px_rgba(6,182,212,0.5)] transition-shadow flex items-center justify-center gap-2 overflow-hidden"
                >
                  <div className="absolute inset-0 bg-white/20 translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-700 ease-in-out" />
                  {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <><Sparkles className="w-4 h-4" /> Start 3-Day Free Trial</>}
                </motion.button>
                
                <div className="grid grid-cols-2 gap-3 pt-2">
                  <motion.button
                     whileHover={{ scale: 1.02 }}
                     whileTap={{ scale: 0.98 }}
                     onClick={() => handlePayment('monthly', 100)}
                     className="py-3 rounded-xl border border-white/5 bg-white/5 hover:bg-white/10 transition-colors text-white text-sm font-semibold flex flex-col items-center justify-center"
                  >
                    <span className="text-xs text-gray-400 mb-0.5">Pay Monthly</span>
                    <span className="text-amber-400 text-base">₹100</span>
                  </motion.button>
                  <motion.button
                     whileHover={{ scale: 1.02, y: -2 }}
                     whileTap={{ scale: 0.98 }}
                     onClick={() => handlePayment('yearly', 700)}
                     className="relative overflow-hidden py-3 rounded-xl border border-amber-500/30 bg-amber-500/10 hover:bg-amber-500/20 transition-all text-white text-sm font-semibold flex flex-col items-center justify-center group shadow-[0_0_15px_rgba(245,158,11,0.15)] hover:shadow-[0_0_20px_rgba(245,158,11,0.3)]"
                  >
                    <div className="absolute inset-0 bg-gradient-to-r from-transparent via-amber-400/10 to-transparent translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-700" />
                    <span className="text-xs text-amber-500 mb-0.5 font-bold uppercase tracking-wider">Save 42%</span>
                    <span className="text-amber-400 text-base">₹700<span className="text-[10px] text-amber-400/60 font-medium ml-0.5">/yr</span></span>
                  </motion.button>
                </div>
                
                {paymentFallback && (
                  <motion.div 
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    className="mt-4 p-3 bg-amber-500/10 border border-amber-500/20 rounded-xl flex items-center gap-3 text-amber-200/80 text-xs"
                  >
                    <QrCode className="w-5 h-5 shrink-0 text-amber-400" />
                    <p>UPI intent may not work on desktop. Please navigate to the Subscription page to scan the QR code.</p>
                  </motion.div>
                )}
              </div>
            </div>
            
            <div className="bg-white/5 p-4 text-center border-t border-white/5 flex items-center justify-center relative z-10">
              <button 
                onClick={onClose}
                className="text-[10px] text-gray-500 hover:text-white transition-colors uppercase tracking-widest font-bold"
              >
                Continue with Basic Mode
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

export default function UpgradeModal(props) {
  return (
    <ErrorBoundary>
      <UpgradeModalContent {...props} />
    </ErrorBoundary>
  );
}
