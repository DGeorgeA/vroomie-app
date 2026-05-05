import React from "react";
import { motion } from "framer-motion";
import { X, AlertTriangle, CheckCircle, TrendingUp, Activity, Info, Wrench } from "lucide-react";
import GlassCard from "../ui/GlassCard";
import GlassButton from "../ui/GlassButton";
import AudioWaveform from "./AudioWaveform";
import { format } from "date-fns";
import { getFaultNarrative } from "@/lib/audioMatchingEngine";

export default function AnalysisDetails({ analysis, onClose }) {
  if (!analysis) return null;

  const getSeverityColor = (severity) => {
    const colors = {
      low: "bg-green-500/20 text-green-400 border-green-500/30",
      medium: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
      high: "bg-orange-500/20 text-orange-400 border-orange-500/30",
      critical: "bg-red-500/20 text-red-400 border-red-500/30",
    };
    return colors[severity] || colors.low;
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.9, opacity: 0 }}
        onClick={(e) => e.stopPropagation()}
        className="max-w-5xl w-full max-h-[90vh] overflow-y-auto"
      >
        <GlassCard className="p-6">
          {/* Header */}
          <div className="flex items-start justify-between mb-6">
            <div>
              <h2 className="text-2xl font-bold text-white mb-2">
                Analysis Details
              </h2>
              <p className="text-gray-400">
                {(() => {
                  const ts = analysis.created_at || analysis.processed_at || analysis.created_date;
                  if (!ts) return 'Unknown Date';
                  try { return format(new Date(ts), "MMMM d, yyyy 'at' h:mm:ss a"); }
                  catch { return 'Invalid Date'; }
                })()}
              </p>
            </div>
            <button
              onClick={onClose}
              className="p-2 rounded-lg bg-white/5 hover:bg-white/10 transition-colors"
            >
              <X className="w-5 h-5 text-gray-400" />
            </button>
          </div>

          {/* Overall Health Status */}
          <div className="grid md:grid-cols-3 gap-4 mb-6">
            <GlassCard className="p-4">
              <div className="flex items-center gap-3">
                {analysis.analysis_result?.overall_health === "healthy" ? (
                  <CheckCircle className="w-8 h-8 text-green-400" />
                ) : (
                  <AlertTriangle className="w-8 h-8 text-yellow-400" />
                )}
                <div>
                  <p className="text-sm text-gray-400">Overall Health</p>
                  <p className="text-lg font-bold text-white capitalize">
                    {analysis.analysis_result?.overall_health || "Unknown"}
                  </p>
                </div>
              </div>
            </GlassCard>

            <GlassCard className="p-4">
              <div className="flex items-center gap-3">
                <TrendingUp className="w-8 h-8 text-blue-400" />
                <div>
                  <p className="text-sm text-gray-400">Confidence Score</p>
                  <p className="text-lg font-bold text-white">
                    {analysis.confidence_score?.toFixed(1)}%
                  </p>
                </div>
              </div>
            </GlassCard>

            <GlassCard className="p-4">
              <div className="flex items-center gap-3">
                <Activity className="w-8 h-8 text-purple-400" />
                <div>
                  <p className="text-sm text-gray-400">Duration</p>
                  <p className="text-lg font-bold text-white">
                    {analysis.duration_seconds}s
                  </p>
                </div>
              </div>
            </GlassCard>
          </div>

          {/* Waveform */}
          <div className="mb-6">
            <h3 className="text-lg font-semibold text-white mb-3">
              Audio Waveform
            </h3>
            <GlassCard className="p-4">
              <AudioWaveform
                anomalies={analysis.anomalies_detected || []}
                duration={analysis.duration_seconds || 0}
              />
            </GlassCard>
          </div>

          {/* Frequency Analysis */}
          {analysis.analysis_result?.frequency_analysis && (
            <div className="mb-6">
              <h3 className="text-lg font-semibold text-white mb-3">
                Frequency Analysis
              </h3>
              <div className="grid md:grid-cols-3 gap-4">
                {Object.entries(analysis.analysis_result.frequency_analysis).map(
                  ([freq, status]) => (
                    <GlassCard key={freq} className="p-4">
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-gray-400 capitalize">
                          {freq.replace("_", " ")}
                        </span>
                        <span
                          className={`px-2 py-1 rounded-full text-xs font-medium ${
                            status === "normal"
                              ? "bg-green-500/20 text-green-400"
                              : status === "elevated"
                              ? "bg-yellow-500/20 text-yellow-400"
                              : "bg-red-500/20 text-red-400"
                          }`}
                        >
                          {status}
                        </span>
                      </div>
                    </GlassCard>
                  )
                )}
              </div>
            </div>
          )}

          {/* Anomalies */}
          {analysis.anomalies_detected && analysis.anomalies_detected.length > 0 && (
            <div className="mb-6">
              <h3 className="text-lg font-semibold text-white mb-3">
                Detected Anomalies ({analysis.anomalies_detected.length})
              </h3>
              <div className="space-y-3">
                {analysis.anomalies_detected.map((anomaly, index) => {
                  const narrative = getFaultNarrative(anomaly.type);
                  return (
                  <GlassCard key={index} className="p-4">
                    <div className="flex items-start justify-between mb-3">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-2">
                          <h4 className="text-white font-medium">
                            {anomaly.type}
                          </h4>
                          <span
                            className={`px-2 py-0.5 rounded-full text-xs font-bold border ${getSeverityColor(
                              anomaly.severity
                            )}`}
                          >
                            {anomaly.severity?.toUpperCase()}
                          </span>
                        </div>
                        <p className="text-sm text-gray-400 mb-3">
                          {anomaly.description}
                        </p>

                        {/* ── Nature of Issue ─────────────────────────────── */}
                        {narrative && (
                          <div className="space-y-2 mt-3">
                            <div className="rounded-lg bg-orange-500/5 border border-orange-500/20 p-3">
                              <div className="flex items-center gap-1.5 mb-1">
                                <Info className="w-3.5 h-3.5 text-orange-400 flex-shrink-0" />
                                <span className="text-xs font-semibold text-orange-400 uppercase tracking-wide">Nature of Issue</span>
                              </div>
                              <p className="text-xs text-gray-300 leading-relaxed">{narrative.nature}</p>
                            </div>
                            <div className="rounded-lg bg-emerald-500/5 border border-emerald-500/20 p-3">
                              <div className="flex items-center gap-1.5 mb-1">
                                <Wrench className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
                                <span className="text-xs font-semibold text-emerald-400 uppercase tracking-wide">Suggested Fix</span>
                              </div>
                              <p className="text-xs text-gray-300 leading-relaxed">{narrative.fix}</p>
                            </div>
                          </div>
                        )}
                        {/* ─────────────────────────────────────────────────── */}

                        <div className="flex gap-4 text-xs text-gray-500 mt-3">
                          {anomaly.timestamp && (
                            <span>Time: {anomaly.timestamp.toFixed(1)}s</span>
                          )}
                          {anomaly.frequency_range && (
                            <span>Frequency: {anomaly.frequency_range}</span>
                          )}
                        </div>
                      </div>
                    </div>
                  </GlassCard>
                  );
                })}
              </div>
            </div>
          )}

          {/* Notes */}
          {analysis.notes && (
            <div className="mb-6">
              <h3 className="text-lg font-semibold text-white mb-3">
                Analysis Notes
              </h3>
              <GlassCard className="p-4">
                <p className="text-gray-300">{analysis.notes}</p>
              </GlassCard>
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-3">
            <GlassButton onClick={onClose} variant="secondary" className="flex-1">
              Close
            </GlassButton>
            {analysis.audio_file_url && (
              <a
                href={analysis.audio_file_url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1"
              >
                <GlassButton className="w-full">
                  Download Audio
                </GlassButton>
              </a>
            )}
          </div>
        </GlassCard>
      </motion.div>
    </motion.div>
  );
}