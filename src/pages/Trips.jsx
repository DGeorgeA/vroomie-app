import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { supabase } from '@/lib/supabase';
import { toast } from 'sonner';
import AnalysisHistory from "@/components/predictive/AnalysisHistory";
import AnalysisDetails from "@/components/predictive/AnalysisDetails";

export default function Trips() {
  const [analyses, setAnalyses] = useState([]);
  const [analysesLoading, setAnalysesLoading] = useState(true);
  const [selectedAnalysis, setSelectedAnalysis] = useState(null);

  useEffect(() => {
    let isMounted = true;
    const fetchHistory = async () => {
      try {
        const { data, error } = await supabase
          .from('analyses')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(100);

        if (error) throw error;
        if (isMounted) {
          setAnalyses((data || []).map(row => ({ ...row, created_date: row.created_at })));
        }
      } catch (err) {
        console.error('Error fetching history:', err);
        toast.error('Failed to load trips');
      } finally {
        if (isMounted) setAnalysesLoading(false);
      }
    };
    fetchHistory();

    const channel = supabase
      .channel('realtime:analyses:trips')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'analyses' },
        (payload) => {
          if (isMounted) {
             const newRow = { ...payload.new, created_date: payload.new.created_at };
             setAnalyses(prev => {
                if (prev.some(r => r.id === newRow.id)) return prev;
                return [newRow, ...prev];
             });
          }
        }
      )
      .subscribe();

    return () => {
      isMounted = false;
      supabase.removeChannel(channel);
    };
  }, []);

  const handleClearHistory = async () => {
    const confirmed = window.confirm(
      'This will permanently delete ALL diagnostic records. This cannot be undone. Continue?'
    );
    if (!confirmed) return;

    try {
      const { error } = await supabase
        .from('analyses')
        .delete()
        .gte('created_at', '2000-01-01');

      if (error) throw error;
      setAnalyses([]);
      toast.success('All diagnostic records cleared.');
    } catch (err) {
      console.error('Failed to clear history:', err);
      toast.error('Unable to clear records. Check Supabase RLS policies.');
    }
  };

  return (
    <div className="max-w-5xl mx-auto">
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
        <AnalysisHistory
          analyses={analyses}
          isLoading={analysesLoading}
          onSelectAnalysis={setSelectedAnalysis}
          onClearHistory={handleClearHistory}
        />
      </motion.div>

      <AnimatePresence>
        {selectedAnalysis && (
          <AnalysisDetails
            analysis={selectedAnalysis}
            onClose={() => setSelectedAnalysis(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
