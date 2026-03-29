import React, { useState } from "react";
import { motion } from "framer-motion";
import { format } from "date-fns";
import { AlertTriangle, CheckCircle, Clock, ExternalLink, Download, FileText, FileSpreadsheet, TrendingUp, Activity, ChevronDown } from "lucide-react";
import GlassCard from "../ui/GlassCard";
import { Skeleton } from "@/components/ui/skeleton";
import { calculateRecurrence } from "../../lib/diagnosticsAggregator";
import { generatePDFReport, generateCSVReport, generateSingleEntryPDFReport } from "../../lib/reportGenerator";
import { getDiagnosticMetadata } from "../../lib/diagnosticDictionary";

export default function AnalysisHistory({ 
  analyses = [], 
  isLoading = false,
  onSelectAnalysis 
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
      <GlassCard className="p-8 text-center">
        <Clock className="w-12 h-12 text-gray-500 mx-auto mb-3" />
        <p className="text-gray-400">No analyses yet.</p>
        <p className="text-gray-500 text-sm mt-1">
          Start hardware recording to generate engine health diagnostics.
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
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-white flex items-center gap-2">
          <Activity className="w-5 h-5 text-blue-400" /> Diagnostics Record
        </h2>
        
        <div className="relative">
          <button 
            onClick={() => setShowDropdown(!showDropdown)}
            className="flex items-center gap-2 bg-gradient-to-r from-blue-600 to-blue-800 hover:from-blue-500 hover:to-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-all shadow-lg hover:shadow-blue-500/25 border border-blue-400/20 z-10"
          >
            <Download className="w-4 h-4" />
            Download Report
            <ChevronDown className="w-4 h-4 ml-1" />
          </button>
          
          {showDropdown && (
            <div className="absolute right-0 mt-2 w-56 bg-zinc-900 border border-zinc-800/80 rounded-lg shadow-2xl z-50 overflow-hidden">
              <button onClick={triggerPDF} className="w-full text-left px-4 py-3 text-sm text-gray-300 hover:bg-zinc-800 hover:text-white flex items-center gap-2 transition-colors border-b border-zinc-800/50">
                <FileText className="w-4 h-4 text-red-400" /> Export Professional PDF
              </button>
              <button onClick={triggerCSV} className="w-full text-left px-4 py-3 text-sm text-gray-300 hover:bg-zinc-800 hover:text-white flex items-center gap-2 transition-colors">
                <FileSpreadsheet className="w-4 h-4 text-green-400" /> Export Raw CSV Metrics
              </button>
            </div>
          )}
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
                    <p className="text-xs text-gray-400 mt-0.5">Caught {trend.count}x • Status: <span className="text-gray-300 font-medium">{trend.trend}</span></p>
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
          let badgeText = "✅ NO ANOMALY DETECTED";
          
          if (dominantStatus === 'anomaly') {
             cardBorder = 'border-red-500/20 bg-red-900/5';
             badgeClass = getSeverityColor(anomalies[0]?.severity);
             badgeText = `❗ ANOMALY DETECTED: ${anomalies[0]?.type.toUpperCase()}`;
          } else if (dominantStatus === 'potential_anomaly') {
             cardBorder = 'border-yellow-500/20 bg-yellow-900/5';
             badgeClass = "bg-yellow-500/20 text-yellow-400 border-yellow-500/30";
             badgeText = `⚠️ POTENTIAL ANOMALY: ${anomalies[0]?.type.toUpperCase()}`;
          }
          
          return (
            <motion.div
              key={analysis.id || index}
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: index * 0.05 }}
            >
              <GlassCard 
                className={`p-4 cursor-pointer border ${cardBorder}`}
                hover
                onClick={() => onSelectAnalysis && onSelectAnalysis(analysis)}
              >
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-3">
                    {getHealthIcon(dominantStatus)}
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span
                          className={`px-2 py-1 rounded-full text-[10px] font-bold tracking-wide border uppercase ${badgeClass}`}
                        >
                          {badgeText}
                        </span>
                        {analysis.detection_mode === 'hybrid' && analysis.mlConfidence !== undefined ? (
                          <div className="flex gap-2">
                            <span className="text-[10px] bg-blue-500/10 text-blue-400 px-1.5 py-0.5 rounded border border-blue-500/20">
                              ML: {(analysis.mlConfidence * 100).toFixed(1)}%
                            </span>
                            <span className="text-[10px] bg-emerald-500/10 text-emerald-400 px-1.5 py-0.5 rounded border border-emerald-500/20">
                              Signal: {(analysis.signalSimilarity * 100).toFixed(1)}%
                            </span>
                          </div>
                        ) : analysis.confidence_score ? (
                          <span className="text-xs text-gray-400 font-mono">
                            {analysis.confidence_score.toFixed(1)}% conf
                          </span>
                        ) : null}
                        {analysis.detection_mode && (
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold border ${
                            analysis.detection_mode === 'ml' 
                              ? 'bg-blue-500/15 text-blue-300 border-blue-500/30' 
                              : 'bg-zinc-800 text-zinc-400 border-zinc-700'
                          }`}>
                            {analysis.detection_mode === 'ml' ? '🤖 ML' : '🔊 Basic'}
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-gray-400 mt-1">
                        {analysis.processed_at
                          ? format(new Date(analysis.processed_at), "MMM d, yyyy 'at' h:mm a")
                          : analysis.created_date 
                            ? format(new Date(analysis.created_date), "MMM d, yyyy 'at' h:mm a")
                            : "Unknown Date"}
                      </p>
                    </div>
                  </div>

                  <div className="flex gap-2">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        generateSingleEntryPDFReport(analysis);
                      }}
                      className="p-1.5 rounded-lg bg-blue-500/10 hover:bg-blue-500/20 text-blue-400 hover:text-blue-300 transition-colors border border-blue-500/20"
                      title="Download Report"
                    >
                      <Download className="w-4 h-4" />
                    </button>
                    {analysis.audio_file_url && (
                      <a
                        href={analysis.audio_file_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-gray-400 hover:text-white transition-colors border border-white/5"
                        title="View Audio File"
                      >
                        <ExternalLink className="w-4 h-4" />
                      </a>
                    )}
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
                                 ₹{diagnosticMeta.inr.toLocaleString()} INR
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