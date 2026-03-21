/**
 * Analyzes full diagnostic history mapping occurrences across entire timelines.
 * Designed to provide insight into escalating mechanical faults.
 */

export function calculateRecurrence(historyData) {
  if (!historyData || !Array.isArray(historyData)) return [];
  
  const anomalyMap = {};
  
  historyData.forEach(session => {
    if (session.anomalies_detected && session.anomalies_detected.length > 0) {
      const timestamp = new Date(session.processed_at || session.created_date).getTime();
      
      session.anomalies_detected.forEach(anomaly => {
        const type = anomaly.type;
        if (!anomalyMap[type]) {
          anomalyMap[type] = {
            name: type,
            count: 0,
            firstOccurrence: timestamp,
            latestOccurrence: timestamp,
            severityLevels: []
          };
        }
        
        anomalyMap[type].count += 1;
        anomalyMap[type].severityLevels.push(anomaly.severity);
        
        // Map edges of the timeline dynamically
        if (timestamp < anomalyMap[type].firstOccurrence) {
          anomalyMap[type].firstOccurrence = timestamp;
        }
        if (timestamp > anomalyMap[type].latestOccurrence) {
          anomalyMap[type].latestOccurrence = timestamp;
        }
      });
    }
  });
  
  return Object.values(anomalyMap).map(anomaly => {
    // Compute simple regression tracking:
    // If anomalies recur massively inside short timeframes, label "Increasing". 
    // For MVP scope, we extrapolate trend using raw hits.
    let trend = "Stable";
    if (anomaly.count > 3) trend = "Increasing";
    else if (anomaly.count === 1) trend = "Stable";
    
    return {
      ...anomaly,
      trend,
      highestSeverity: anomaly.severityLevels.includes('critical') ? 'critical' :
                       anomaly.severityLevels.includes('high') ? 'high' :
                       anomaly.severityLevels.includes('medium') ? 'medium' : 'low'
    };
  }).sort((a, b) => b.count - a.count); // Highest hits rise to the top
}
