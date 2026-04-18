import React, { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Star, Send, CheckCircle, Loader2, MessageSquare } from "lucide-react";
import { supabase } from "@/lib/supabase";

// ─── Feature Flag ──────────────────────────────────────────────────────────────
const FEEDBACK_ENABLED = import.meta.env.VITE_FEEDBACK_ENABLED !== "false";

const RATINGS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

const RATING_LABELS = {
  1: "😤 Very Poor",
  2: "😞 Poor",
  3: "😕 Below Average",
  4: "😐 Fair",
  5: "🙂 Average",
  6: "😊 Good",
  7: "😄 Great",
  8: "🤩 Excellent",
  9: "🚀 Outstanding",
  10: "🏆 Perfect",
};

export default function CustomerFeedback() {
  // ─── Feature flag guard — zero render if disabled ──────────────────────────
  if (!FEEDBACK_ENABLED) return null;

  const [selectedRating, setSelectedRating] = useState(null);
  const [comment, setComment] = useState("");
  const [status, setStatus] = useState("idle"); // idle | loading | success | error

  const handleSubmit = async () => {
    if (!selectedRating) return;
    if (status === "loading" || status === "success") return;

    setStatus("loading");

    try {
      const { error } = await supabase.from("customer_feedback").insert({
        rating: selectedRating,
        comment: comment.trim() || null,
        user_name: null, // future: hook into AuthContext
      });

      if (error) throw error;

      setStatus("success");
      console.log("[Vroomie Feedback] Submitted:", { rating: selectedRating, comment });
    } catch (err) {
      console.error("[Vroomie Feedback] Insert failed:", err.message);
      setStatus("error");
      // Auto-reset error state after 4s so user can retry
      setTimeout(() => setStatus("idle"), 4000);
    }
  };

  const handleReset = () => {
    setSelectedRating(null);
    setComment("");
    setStatus("idle");
  };

  return (
    <motion.div
      id="customer-feedback"
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.9, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      className="mt-6 md:mt-12"
    >
      {/* Container card — matches GlassCard aesthetic */}
      <div className="relative bg-white/[0.03] border border-white/10 rounded-2xl p-5 md:p-8 backdrop-blur-sm overflow-hidden">
        {/* Background glow accent */}
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute -top-12 -right-12 w-48 h-48 bg-yellow-300/5 rounded-full blur-3xl" />
          <div className="absolute -bottom-8 -left-8 w-32 h-32 bg-cyan-500/5 rounded-full blur-2xl" />
        </div>

        <AnimatePresence mode="wait">
          {/* ─── SUCCESS STATE ──────────────────────────────────────────── */}
          {status === "success" ? (
            <motion.div
              key="success"
              initial={{ opacity: 0, scale: 0.92 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.92 }}
              transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
              className="flex flex-col items-center justify-center py-8 gap-4 text-center"
            >
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ delay: 0.1, type: "spring", stiffness: 260, damping: 20 }}
                className="w-16 h-16 rounded-full bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center"
              >
                <CheckCircle className="w-8 h-8 text-emerald-400" />
              </motion.div>

              <div>
                <h3 className="text-lg font-semibold text-white mb-1">
                  Thanks for helping us improve Vroomie 🚗
                </h3>
                <p className="text-sm text-gray-400">
                  Your feedback shapes the future of AI diagnostics.
                </p>
              </div>

              <button
                onClick={handleReset}
                className="mt-2 text-xs text-gray-500 hover:text-gray-300 transition-colors underline underline-offset-4"
              >
                Submit another response
              </button>
            </motion.div>
          ) : (
            /* ─── FORM STATE ─────────────────────────────────────────────── */
            <motion.div
              key="form"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="relative z-10"
            >
              {/* Header */}
              <div className="flex items-start gap-3 mb-6">
                <div className="flex-shrink-0 w-9 h-9 rounded-xl bg-yellow-300/10 border border-yellow-300/25 flex items-center justify-center">
                  <MessageSquare className="w-4 h-4 text-yellow-300" />
                </div>
                <div>
                  <h3 className="text-base font-semibold text-white leading-snug">
                    How would you rate your experience with Vroomie?
                  </h3>
                  <p className="text-xs text-gray-500 mt-0.5">
                    Your honest feedback helps us build better AI diagnostics.
                  </p>
                </div>
              </div>

              {/* ─── Rating Pills ─────────────────────────────────────── */}
              <div className="mb-2">
                <div className="flex gap-1.5 flex-wrap">
                  {RATINGS.map((n) => {
                    const isSelected = selectedRating === n;
                    return (
                      <motion.button
                        key={n}
                        id={`feedback-rating-${n}`}
                        onClick={() => setSelectedRating(n)}
                        whileTap={{ scale: 0.88 }}
                        whileHover={{ scale: 1.08 }}
                        transition={{ type: "spring", stiffness: 400, damping: 20 }}
                        aria-label={`Rate ${n} out of 10`}
                        aria-pressed={isSelected}
                        className={`
                          relative w-9 h-9 rounded-xl text-sm font-bold
                          border transition-colors duration-200
                          focus:outline-none focus-visible:ring-2 focus-visible:ring-yellow-300/80
                          ${isSelected
                            ? "bg-yellow-300 text-black border-yellow-200 shadow-[0_0_16px_rgba(252,211,77,0.45)]"
                            : "bg-white/5 text-gray-400 border-white/10 hover:bg-white/10 hover:text-white hover:border-white/20"
                          }
                        `}
                      >
                        {n}
                        {isSelected && (
                          <motion.span
                            layoutId="rating-glow"
                            className="absolute inset-0 rounded-xl ring-2 ring-yellow-300/50"
                          />
                        )}
                      </motion.button>
                    );
                  })}
                </div>

                {/* Dynamic rating label */}
                <AnimatePresence mode="wait">
                  {selectedRating && (
                    <motion.p
                      key={selectedRating}
                      initial={{ opacity: 0, y: -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.2 }}
                      className="mt-2 text-xs text-yellow-300/80 font-medium"
                    >
                      {RATING_LABELS[selectedRating]}
                    </motion.p>
                  )}
                </AnimatePresence>
              </div>

              {/* ─── Comment Box ──────────────────────────────────────── */}
              <div className="mt-4 mb-5">
                <textarea
                  id="feedback-comment"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="Tell us what worked well or what we can improve..."
                  rows={3}
                  maxLength={500}
                  disabled={status === "loading"}
                  className="
                    w-full px-3 py-2.5 bg-white/[0.04] border border-white/10
                    rounded-xl text-sm text-white placeholder-gray-600
                    resize-none focus:outline-none focus:border-yellow-300/40
                    focus:bg-white/[0.06] transition-all duration-200
                    disabled:opacity-50 disabled:cursor-not-allowed
                  "
                />
                <div className="flex justify-end mt-1">
                  <span className="text-[10px] text-gray-600">{comment.length}/500</span>
                </div>
              </div>

              {/* ─── Submit Button ────────────────────────────────────── */}
              <div className="flex items-center gap-3">
                <motion.button
                  id="feedback-submit"
                  onClick={handleSubmit}
                  disabled={!selectedRating || status === "loading"}
                  whileTap={selectedRating && status !== "loading" ? { scale: 0.96 } : {}}
                  className={`
                    flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold
                    transition-all duration-200 focus:outline-none
                    focus-visible:ring-2 focus-visible:ring-yellow-300/80
                    ${!selectedRating || status === "loading"
                      ? "bg-white/5 text-gray-600 cursor-not-allowed border border-white/5"
                      : "bg-yellow-300 text-black hover:bg-yellow-200 shadow-[0_0_20px_rgba(252,211,77,0.25)] hover:shadow-[0_0_28px_rgba(252,211,77,0.4)] border border-yellow-200/30"
                    }
                  `}
                >
                  {status === "loading" ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Submitting...
                    </>
                  ) : (
                    <>
                      <Send className="w-4 h-4" />
                      Submit Feedback
                    </>
                  )}
                </motion.button>

                {/* Inline error message */}
                <AnimatePresence>
                  {status === "error" && (
                    <motion.span
                      initial={{ opacity: 0, x: -8 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0 }}
                      className="text-xs text-red-400"
                    >
                      Submission failed — please retry.
                    </motion.span>
                  )}
                  {!selectedRating && status === "idle" && (
                    <motion.span
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="text-xs text-gray-600"
                    >
                      Select a rating to continue
                    </motion.span>
                  )}
                </AnimatePresence>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
