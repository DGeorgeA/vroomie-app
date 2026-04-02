import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Activity, AlertTriangle, CheckCircle, TrendingUp, Globe } from "lucide-react";
import GlassCard from "../components/ui/GlassCard";
import AudioWaveform from "../components/predictive/AudioWaveform";
import AudioRecorder from "../components/predictive/AudioRecorder";
import AnalysisHistory from "../components/predictive/AnalysisHistory";
import AnalysisDetails from "../components/predictive/AnalysisDetails";
import { toast } from 'sonner';
import { LANGUAGES } from '@/utils/voice';

export default function PredictiveMaintenance() {
  const [selectedVehicle, setSelectedVehicle] = useState(null);
  const [vehicles, setVehicles] = useState([]);
  const [analyses, setAnalyses] = useState([]);
  const [analysesLoading, setAnalysesLoading] = useState(false);

  const [selectedAnalysis, setSelectedAnalysis] = useState(null);
  const [isRecording, setIsRecording] = useState(false);
  const [analyser, setAnalyser] = useState(null);
  const [audioContext, setAudioContext] = useState(null);

  // Voice & Language State — default English (US)
  const [language, setLanguage] = useState('en-US');

  // MOCK DATA: Vehicles
  useEffect(() => {
    // Simulate API fetch delay
    setTimeout(() => {
      const mockVehicles = [
        { id: 'v1', make: 'Porsche', model: '911 GT3', vin: 'WP0ZZZ99ZTS390', year: 2023 },
        { id: 'v2', make: 'BMW', model: 'M4 Competition', vin: 'WBS33AZ050FM', year: 2024 },
        { id: 'v3', make: 'Audi', model: 'RS6 Avant', vin: 'WAUZZZ4A0MN0', year: 2023 }
      ];
      setVehicles(mockVehicles);
      if (mockVehicles.length > 0 && !selectedVehicle) {
        setSelectedVehicle(mockVehicles[0]);
      }
    }, 800);
  }, []); // Run once on mount

  // MOCK DATA: Analyses (whenever selectedVehicle changes)
  useEffect(() => {
    if (!selectedVehicle) return;

    setAnalysesLoading(true);
    // Simulate API fetch delay
    setTimeout(() => {
      // Different mock data based on vehicle to show variety
      const isHealthy = selectedVehicle.id === 'v1';

      const mockAnalyses = Array.from({ length: 5 }).map((_, i) => ({
        id: `analysis-${selectedVehicle.id}-${i}`,
        created_date: new Date(Date.now() - i * 86400000).toISOString(),
        vehicle_id: selectedVehicle.id,
        duration_seconds: 15,
        confidence_score: isHealthy ? 98 - i : 85 - i * 5, // Healthy vehicle has higher scores across history
        status: (isHealthy || i > 0) ? 'success' : 'flagged',
        analysis_result: {
          overall_health: (isHealthy || i > 0) ? 'healthy' : 'warning',
          anomalies_detected: (isHealthy || i > 0) ? [] : [
            { type: "Knocking", severity: "medium", timestamp: 2.5 },
            { type: "Belt Squeal", severity: "low", timestamp: 8.2 }
          ]
        }
      }));

      setAnalyses(mockAnalyses);
      setAnalysesLoading(false);
    }, 600);
  }, [selectedVehicle]);

  const refetchAnalyses = () => {
    // Re-trigger the effect logic basically, or just re-set loading
    setAnalysesLoading(true);
    setTimeout(() => {
      setAnalysesLoading(false);
    }, 1000);
  };

  // Calculate stats from analyses
  const stats = React.useMemo(() => {
    const total = analyses.length;
    const flagged = analyses.filter(a => a.status === 'flagged').length;
    const avgConfidence = analyses.length > 0
      ? analyses.reduce((sum, a) => sum + (a.confidence_score || 0), 0) / analyses.length
      : 0;

    const recentAnalysis = analyses[0];
    const overallHealth = recentAnalysis?.analysis_result?.overall_health || 'unknown';

    return { total, flagged, avgConfidence, overallHealth };
  }, [analyses]);

  const handleRecordingComplete = () => {
    setTimeout(() => {
      refetchAnalyses();
    }, 1000);
  };

  const handleAnomalyDetected = (anomaly) => {
    toast.warning(`${anomaly.severity.toUpperCase()} anomaly detected!`, {
      description: anomaly.type,
      duration: 5000,
    });
  };

  return (
    <div className="min-h-screen py-6 md:py-12 px-2 md:px-4 lg:px-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center mb-4 md:mb-8"
        >
          <div className="flex flex-col items-center">
            <div className="w-full flex justify-between items-start mb-2 px-2">
              {/* Language Selector */}
              <div className="relative group">
                <button className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/5 border border-white/10 hover:bg-white/10 transition-colors text-xs text-gray-300">
                  <Globe className="w-3 h-3" />
                  <span>{LANGUAGES.find(l => l.code === language)?.name || language}</span>
                </button>

                <div className="absolute top-full left-0 mt-2 py-2 w-40 bg-zinc-900 border border-white/10 rounded-xl shadow-xl opacity-0 group-hover:opacity-100 pointer-events-none group-hover:pointer-events-auto transition-all z-50">
                  {LANGUAGES.map((lang) => (
                    <button
                      key={lang.code}
                      onClick={() => setLanguage(lang.code)}
                      className={`w-full text-left px-4 py-2 text-xs hover:bg-white/10 transition-colors ${language === lang.code ? 'text-yellow-300' : 'text-gray-400'}`}
                    >
                      {lang.name}
                    </button>
                  ))}
                </div>
              </div>

              <div className="w-8"></div>
            </div>

            <div className="inline-flex items-center gap-2 backdrop-blur-md bg-yellow-300/10 border border-yellow-300/30 rounded-full px-3 md:px-4 py-1.5 md:py-2 mb-3 md:mb-6">
              <Activity className="w-3 h-3 md:w-4 md:h-4 text-yellow-300" />
              <span className="text-yellow-300 text-xs md:text-sm font-medium">AI-Powered Diagnostics</span>
            </div>
          </div>
          <h1 className="text-3xl md:text-5xl lg:text-7xl font-bold mb-2 md:mb-4 tracking-tight">
            <span className="bg-gradient-to-r from-yellow-300 via-yellow-100 to-white bg-clip-text text-transparent">
              Instant Car Health Checkup
            </span>
          </h1>
          <p className="text-sm md:text-xl text-gray-400 max-w-3xl mx-auto px-4 mt-4">
            Real-time engine audio analysis. Detect issues in seconds.
          </p>
        </motion.div>

        {/* Vehicle Details (Optional) */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="mb-6 max-w-2xl mx-auto"
        >
          <div className="bg-white/5 border border-white/10 rounded-xl p-4 backdrop-blur-sm">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xs text-yellow-300 font-medium px-2 py-0.5 bg-yellow-300/10 rounded-full border border-yellow-300/20">Optional</span>
              <p className="text-sm text-gray-300 font-medium">Add Vehicle Details for Better Accuracy</p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <input
                type="text"
                placeholder="Car Name (e.g., Honda City)"
                className="bg-black/20 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-yellow-300/50 transition-colors"
              />
              <input
                type="text"
                placeholder="VIN / Reg Number"
                className="bg-black/20 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-yellow-300/50 transition-colors"
              />
            </div>
          </div>
        </motion.div>

        {/* MAIN ACTION: Large ECG Visualizer */}
        <div className="mb-8">
          <GlassCard className={`p-1 ${isFullscreenECG ? 'min-h-[85vh]' : 'mx-auto max-w-5xl'}`}>
            <div className={`relative bg-zinc-950/80 rounded-xl overflow-hidden border border-yellow-300/20 shadow-2xl shadow-yellow-900/20 ${isFullscreenECG ? 'h-full' : 'h-[400px] md:h-[500px]'}`}>
              {/* Overlay Content */}
              <div className="absolute top-4 left-4 z-10 flex items-center gap-3">
                <div className="flex items-center gap-2 px-3 py-1 bg-black/40 backdrop-blur-md rounded-full border border-white/10">
                  <Activity className="w-4 h-4 text-emerald-400 animate-pulse" />
                  <span className="text-xs font-medium text-emerald-400">System Ready</span>
                </div>
                {isRecording && (
                  <div className="flex items-center gap-2 px-3 py-1 bg-red-500/20 backdrop-blur-md rounded-full border border-red-500/30 animate-pulse">
                    <span className="w-2 h-2 rounded-full bg-red-500"></span>
                    <span className="text-xs font-medium text-red-400">Device Listening...</span>
                  </div>
                )}
              </div>

              <AudioWaveform
                audioContext={audioContext}
                analyser={analyser}
                isRecording={isRecording}
                anomalies={selectedAnalysis?.anomalies_detected || []}
                duration={selectedAnalysis?.duration_seconds || 0}
                onAnomalyDetected={handleAnomalyDetected}
              />

              {/* Centered Recorder Button if not recording */}
              <div className="absolute bottom-8 left-0 right-0 flex justify-center z-20 pointer-events-none">
                <div className="pointer-events-auto">
                  {/* Audio Recorder Controls - Passing language and implicit vehicle ID */}
                  <AudioRecorder
                    vehicleId={selectedVehicle?.id || 'guest-vehicle'}
                    onRecordingComplete={handleRecordingComplete}
                    language={language}
                  />
                </div>
              </div>
            </div>
          </GlassCard>
        </div>

        {/* Status Overview Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-4 mb-3 md:mb-6">
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}>
            <GlassCard className="p-3 md:p-4">
              <div className="flex items-center justify-between mb-1 md:mb-2">
                <div className={`rounded-lg md:rounded-xl p-1.5 md:p-2 ${stats.overallHealth === 'healthy'
                  ? 'bg-green-500/20 border border-green-500/30'
                  : 'bg-yellow-500/20 border border-yellow-500/30'
                  }`}>
                  {stats.overallHealth === 'healthy' ? (
                    <CheckCircle className="w-4 h-4 md:w-5 md:h-5 text-green-400" />
                  ) : (
                    <AlertTriangle className="w-4 h-4 md:w-5 md:h-5 text-yellow-400" />
                  )}
                </div>
              </div>
              <h3 className="text-base md:text-xl font-bold text-white mb-0.5 md:mb-1 capitalize">{stats.overallHealth}</h3>
              <p className="text-gray-400 text-[10px] md:text-xs">Engine Status</p>
            </GlassCard>
          </motion.div>

          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }}>
            <GlassCard className="p-3 md:p-4">
              <div className="flex items-center justify-between mb-1 md:mb-2">
                <div className="bg-yellow-500/20 border border-yellow-500/30 rounded-lg md:rounded-xl p-1.5 md:p-2">
                  <AlertTriangle className="w-4 h-4 md:w-5 md:h-5 text-yellow-400" />
                </div>
              </div>
              <h3 className="text-base md:text-xl font-bold text-white mb-0.5 md:mb-1">{stats.flagged}</h3>
              <p className="text-gray-400 text-[10px] md:text-xs">Anomalies</p>
            </GlassCard>
          </motion.div>

          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4 }}>
            <GlassCard className="p-3 md:p-4">
              <div className="flex items-center justify-between mb-1 md:mb-2">
                <div className="bg-blue-500/20 border border-blue-500/30 rounded-lg md:rounded-xl p-1.5 md:p-2">
                  <TrendingUp className="w-4 h-4 md:w-5 md:h-5 text-blue-400" />
                </div>
              </div>
              <h3 className="text-base md:text-xl font-bold text-white mb-0.5 md:mb-1">{stats.avgConfidence.toFixed(1)}%</h3>
              <p className="text-gray-400 text-[10px] md:text-xs">Accuracy</p>
            </GlassCard>
          </motion.div>

          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.5 }}>
            <GlassCard className="p-3 md:p-4">
              <div className="flex items-center justify-between mb-1 md:mb-2">
                <div className="bg-purple-500/20 border border-purple-500/30 rounded-lg md:rounded-xl p-1.5 md:p-2">
                  <Activity className="w-4 h-4 md:w-5 md:h-5 text-purple-400" />
                </div>
              </div>
              <h3 className="text-base md:text-xl font-bold text-white mb-0.5 md:mb-1">{stats.total}</h3>
              <p className="text-gray-400 text-[10px] md:text-xs">Analyses</p>
            </GlassCard>
          </motion.div>
        </div>

        {/* Analysis History */}
        <div className="grid grid-cols-1 gap-3 md:gap-6">
          <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.7 }}
            className="lg:col-span-3"
          >
            <GlassCard className="p-4 md:p-6">
              <h2 className="text-lg md:text-xl font-bold text-white mb-4 md:mb-6">Analysis History</h2>

              <AnalysisHistory
                analyses={analyses}
                isLoading={analysesLoading}
                onSelectAnalysis={setSelectedAnalysis}
              />
            </GlassCard>
          </motion.div>
        </div>

        {/* Analysis Details Modal */}
        <AnimatePresence>
          {selectedAnalysis && (
            <AnalysisDetails
              analysis={selectedAnalysis}
              onClose={() => setSelectedAnalysis(null)}
            />
          )}
        </AnimatePresence>

        {/* How It Works */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.8 }}
          className="mt-6 md:mt-12"
        >
          <GlassCard className="p-4 md:p-8">
            <h3 className="text-xl md:text-2xl font-bold text-white mb-4 md:mb-6">How Real-Time ECG Monitoring Works</h3>
            <div className="grid md:grid-cols-3 gap-4 md:gap-6">
              <div>
                <div className="text-yellow-300 font-bold text-base md:text-lg mb-2">1. Listen</div>
                <p className="text-gray-400 text-xs md:text-sm">
                  Real-time audio capture with live ECG-style waveform. Watch your engine's "heartbeat" as it runs.
                </p>
              </div>
              <div>
                <div className="text-yellow-300 font-bold text-base md:text-lg mb-2">2. Analyze</div>
                <p className="text-gray-400 text-xs md:text-sm">
                  AI analyzes frequency patterns instantly, detecting anomalies in real-time with audio alerts.
                </p>
              </div>
              <div>
                <div className="text-yellow-300 font-bold text-base md:text-lg mb-2">3. Prevent</div>
                <p className="text-gray-400 text-xs md:text-sm">
                  Get immediate warnings for critical issues. Review detailed reports when you exit the vehicle.
                </p>
              </div>
            </div>
          </GlassCard>
        </motion.div>
      </div>
    </div>
  );
}