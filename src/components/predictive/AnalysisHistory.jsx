import React, { useState } from "react";
import { motion } from "framer-motion";
import { format } from "date-fns";
import { AlertTriangle, CheckCircle, Clock, ExternalLink, Download, FileText, FileSpreadsheet, TrendingUp, Activity, ChevronDown, Trash2 } from "lucide-react";
import GlassCard from "../ui/GlassCard";
import { Skeleton } from "@/components/ui/skeleton";
import { calculateRecurrence } from "../../lib/diagnosticsAggregator";
import { generatePDFReport, generateCSVReport, generateSingleEntryPDFReport } from "../../lib/reportGenerator";
import { getDiagnosticMetadata } from "../../lib/diagnosticDictionary";

export default function AnalysisHistory({ 
  analyses = [], 
  isLoading = false,
  onSelectAnalysis,
  onClearHistory
}) {
  const [showDropdown, setShowDropdown] = useState(false);

  const getSeverityColor = (severity) => {
    const colors = {
      low: "bg-green-500/20 text-green-400 border-green-500/30",
      medium: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
      high: "bg-orange-500/20 text-orange-400 border-orange-500/30",
      critical: "bg-red-500/20 text-red-400 border-red-500/30",
    };
    return colors[severity?.toLowerCase()] || colors.low;
  };

  const getHealthIcon = (status) => {
    if (status === "normal") { 
      return <CheckCircle className="w-5 h-5 text-green-400" />;
    } else if (status === "potential_anomaly") {
      return <AlertTriangle className="w-5 h-5 text-yellow-400" />;
    }
    return <AlertTriangle className="w-5 h-5 text-red-400" />;
  };

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((i) => (
          <GlassCard key={i} className="p-4">
            <Skeleton className="h-16 w-full bg-zinc-800" />
          </GlassCard>
        ))}
      </div>
    );
  }

  if (analyses.length === 0) {
    return (
      <GlassCard className="p-12 text-center border border-dashed border-white/10 bg-black/20">
        <div className="w-16 h-16 rounded-full bg-zinc-900/50 flex items-center justify-center mx-auto mb-4 border border-white/5">
           <Activity className="w-8 h-8 text-zinc-500" />
        </div>
        <h3 className="text-xl font-bold text-white mb-2 tracking-tight">No analysis records yet.</h3>
        <p className="text-zinc-400 text-sm max-w-md mx-auto">
          Start a hardware recording session to generate active engine health diagnostics. Live reports will appear here automatically upon completion.
        </p>
      </GlassCard>
    );
  }

  const aggregatedTrends = calculateRecurrence(analyses);

  const triggerPDF = () => {
    generatePDFReport('Active-Vehicle', analyses, aggregatedTrends);
    setShowDropdown(false);
  };
  
  const triggerCSV = () => {
    generateCSVReport('Active-Vehicle', analyses);
    setShowDropdown(false);
  };

  return (
    <div className="space-y-6">
      {/* Workshop Executive Actions */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
           <div className="w-10 h-10 rounded-xl bg-blue-500/10 flex items-center justify-center border border-blue-500/20 shadow-[0_0_15px_rgba(59,130,246,0.15)]">
             <Activity className="w-5 h-5 text-blue-400" />
           </div>
           <div>
             <h2 className="text-xl font-bold text-white tracking-tight leading-tight">Diagnostics Record</h2>
             <p className="text-xs text-zinc-400 font-medium">Auto-syncing from hardware sensors</p>
           </div>
        </div>
        
        <div className="flex items-center gap-3">
          <button 
            onClick={() => onClearHistory && onClearHistory()}
            title="Clear all records"
            className="flex items-center justify-center w-10 h-10 rounded-lg bg-zinc-900 border border-red-900/40 text-red-500/80 hover:bg-red-950/40 hover:text-red-400 hover:border-red-500/50 transition-all"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        
          <div className="relative">
            <button 
              onClick={() => setShowDropdown(!showDropdown)}
              className="flex items-center gap-2 bg-white text-black hover:bg-zinc-200 px-5 py-2.5 rounded-lg text-sm font-bold transition-all shadow-[0_0_20px_rgba(255,255,255,0.1)] z-10"
            >
              <Download className="w-4 h-4" />
              Download Report
              <ChevronDown className="w-3 h-3 text-zinc-600 ml-1" />
            </button>
            
            {showDropdown && (
              <div className="absolute right-0 mt-2 w-56 bg-zinc-900 border border-zinc-800/80 rounded-xl shadow-2xl z-50 overflow-hidden">
                <button onClick={triggerPDF} className="w-full text-left px-4 py-3 text-sm text-zinc-300 hover:bg-zinc-800 hover:text-white flex items-center gap-3 transition-colors border-b border-zinc-800/50">
                  <FileText className="w-4 h-4 text-red-400" /> Export Professional PDF
                </button>
                <button onClick={triggerCSV} className="w-full text-left px-4 py-3 text-sm text-zinc-300 hover:bg-zinc-800 hover:text-white flex items-center gap-3 transition-colors">
                  <FileSpreadsheet className="w-4 h-4 text-green-400" /> Export Raw CSV Metrics
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Recurrences Overview */}
      {aggregatedTrends.length > 0 && (
        <div className="mb-6">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Mechanical Flags Tracking</h3>
          <div className="space-y-2">
            {aggregatedTrends.map(trend => (
              <GlassCard key={trend.name} className="p-3 border-l-4 border-l-orange-500">
                <div className="flex justify-between items-center">
                  <div>
                    <p className="text-orange-100 font-medium text-sm flex items-center gap-2">
                      <TrendingUp className="w-3.5 h-3.5 text-orange-400" /> {trend.name}
                    </p>
                    <p className="text-xs text-gray-400 mt-0.5">Caught {trend.count}x ΓÇó Status: <span className="text-gray-300 font-medium">{trend.trend}</span></p>
                  </div>
                  <div className={`px-2 py-1 rounded-md text-xs font-bold border ${getSeverityColor(trend.highestSeverity)}`}>
                    {trend.highestSeverity.toUpperCase()}
                  </div>
                </div>
              </GlassCard>
            ))}
          </div>
        </div>
      )}

      {/* Main Timeline */}
      <div className="space-y-3 relative z-0">
        {analyses.map((analysis, index) => {
          const anomalies = analysis.anomalies_detected || [];
          const hasAnomalies = anomalies.length > 0;
          
          let dominantStatus = "normal";
          if (hasAnomalies) {
             if (anomalies.some(a => a.status === 'anomaly' || ['high', 'critical'].includes(a.severity))) {
                 dominantStatus = 'anomaly';
             } else {
                 dominantStatus = 'potential_anomaly';
             }
          }
          
          let cardBorder = 'border-green-500/10';
          let badgeClass = "bg-green-500/20 text-green-400 border-green-500/30";
          let badgeText = "Γ£à NO ANOMALY DETECTED";
          
          if (dominantStatus === 'anomaly') {
             cardBorder = 'border-red-500/20 bg-red-900/5';
             badgeClass = getSeverityColor(anomalies[0]?.severity);
             badgeText = `Γ¥ù ANOMALY DETECTED: ${anomalies[0]?.type.toUpperCase()}`;
          } else if (dominantStatus === 'potential_anomaly') {
             cardBorder = 'border-yellow-500/20 bg-yellow-900/5';
             badgeClass = "bg-yellow-500/20 text-yellow-400 border-yellow-500/30";
             badgeText = `ΓÜá∩╕Å POTENTIAL ANOMALY: ${anomalies[0]?.type.toUpperCase()}`;
          }
          
          return (
            <motion.div
              key={analysis.id || index}
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: index * 0.05 }}
              whileHover={{ scale: 1.01, transition: { duration: 0.2 } }}
            >
              <GlassCard className={`p-5 transition-colors border-l-4 ${cardBorder}`}>
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                  <div className="flex items-start gap-4">
                    <div className="mt-1">
                      {getHealthIcon(dominantStatus)}
                    </div>
                    <div>
                      <div className="flex flex-wrap items-center gap-2 mb-1.5">
                        <h3 className="text-base font-bold text-white tracking-tight">
                          Session {analysis.id?.substring(0, 8)}
                        </h3>
                        {analysis.status === 'flagged' && (
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold border uppercase tracking-widest ${badgeClass}`}>
                            {badgeText}
                          </span>
                        )}
                        {analysis.status !== 'flagged' && (
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold border uppercase tracking-widest ${badgeClass}`}>
                            {badgeText}
                          </span>
                        )}
                        {analysis.detection_mode && (
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold border uppercase tracking-widest ${
                            analysis.detection_mode === 'ml' 
                              ? 'bg-blue-500/15 text-blue-300 border-blue-500/30' 
                              : 'bg-zinc-800 text-zinc-400 border-zinc-700'
                          }`}>
                            {analysis.detection_mode === 'ml' ? '≡ƒñû ML' : '≡ƒöè Basic'}
                          </span>
                        )}
                      </div>
                      
                      <div className="flex items-center gap-3 text-sm">
                      <p className="text-zinc-400 font-medium">
                          {/* ── TIMESTAMP: server created_at is authoritative ──────────────
                           *  Priority: created_at (DB DEFAULT now()) > processed_at > created_date
                           *  Format includes SECONDS so same-minute recordings are distinct.
                           *  Each entry reads from its OWN `analysis` object — no shared state.
                           * ─────────────────────────────────────────────────────── */}
                          {(() => {
                            // Each row provides its own timestamp — never shared across entries
                            const ts = analysis.created_at || analysis.processed_at || analysis.created_date;
                            if (!ts) return 'Unknown Date';
                            try {
                              const parsed = new Date(ts);
                              // Console validation: proves uniqueness per row
                              console.log(`[Vroomie History] Row ${analysis.id} → created_at: ${ts}`);
                              return format(parsed, "MMM d, yyyy 'at' h:mm:ss a");
                            } catch {
                              return 'Invalid Date';
                            }
                          })()}
                        </p>
                        <span className="text-zinc-600">ΓÇó</span>
                        <div className="flex items-center gap-1.5 text-zinc-400 font-medium">
                          <Activity className="w-4 h-4 text-yellow-500/80" /> 
                          {(analysis.confidence_score || 0).toFixed(1)}% Confidence
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-3 md:ml-auto border-t md:border-t-0 pt-4 md:pt-0 border-white/5">
                     <button
                        onClick={() => generateSingleEntryPDFReport(analysis)}
                        className="p-2.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors border border-transparent hover:border-zinc-700"
                        title="Download Evidence"
                     >
                        <Download className="w-5 h-5" />
                     </button>
                     {analysis.audio_file_url && (
                        <a
                           href={analysis.audio_file_url}
                           target="_blank"
                           rel="noopener noreferrer"
                           className="p-2.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors border border-transparent hover:border-zinc-700"
                           title="View Audio File"
                        >
                           <ExternalLink className="w-5 h-5" />
                        </a>
                     )}
                     <button
                        onClick={() => onSelectAnalysis && onSelectAnalysis(analysis)}
                        className="flex items-center gap-2 bg-zinc-800 hover:bg-zinc-700 text-white px-5 py-2.5 rounded-lg text-sm font-semibold transition-colors border border-zinc-700 shadow-[0_0_10px_rgba(0,0,0,0.5)]"
                     >
                        View Analysis
                     </button>
                  </div>
                </div>

                {/* Anomalies List */}
                {hasAnomalies && (
                  <div className="space-y-2 mt-4 pt-4 border-t border-white/5">
                    {anomalies.slice(0, 2).map((anomaly, i) => {
                      const diagnosticMeta = getDiagnosticMetadata(anomaly.type);
                      return (
                        <div
                          key={i}
                          className="bg-black/20 border border-white/5 rounded-md p-3"
                        >
                          <div className="flex items-start justify-between mb-1">
                            <span className="text-sm font-bold text-orange-200">
                              {anomaly.type}
                            </span>
                            <span
                              className={`px-2 py-0.5 rounded text-[10px] font-bold border ${getSeverityColor(anomaly.severity)}`}
                            >
                              {anomaly.severity?.toUpperCase()}
                            </span>
                          </div>
                          
                          <div className="mt-2 space-y-1">
                            <p className="text-xs text-gray-300">
                              <span className="font-semibold text-gray-400">Suggested Fix:</span> {diagnosticMeta.fix}
                            </p>
                            <div className="flex items-center gap-3 pt-1">
                               <p className="text-xs text-green-400 font-mono bg-green-500/10 px-2 py-0.5 rounded border border-green-500/20">
                                 Est: ${diagnosticMeta.usd} USD
                               </p>
                               <p className="text-xs text-blue-400 font-mono bg-blue-500/10 px-2 py-0.5 rounded border border-blue-500/20">
                                 Γé╣{diagnosticMeta.inr.toLocaleString()} INR
                               </p>
                            </div>
                          </div>
                          
                        </div>
                      );
                    })}
                    {anomalies.length > 2 && (
                      <p className="text-xs text-gray-500 text-center mt-2">
                        +{anomalies.length - 2} subsequent anomalies mapped
                      </p>
                    )}
                  </div>
                )}
              </GlassCard>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
