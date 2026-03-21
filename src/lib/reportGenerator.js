import jsPDF from 'jspdf';
import 'jspdf-autotable';
import { format } from 'date-fns';
import { getDiagnosticMetadata } from './diagnosticDictionary';

export function generatePDFReport(vehicleId, historyData, aggregatedTrends) {
  const doc = new jsPDF();
  const dateStr = format(new Date(), "MMM d, yyyy - h:mm a");
  
  // --- HEADER & VROOMIE PREMIUM BRANDING ---
  doc.setFillColor(25, 25, 25); // Sleek Dark Top
  doc.rect(0, 0, 210, 40, 'F');
  
  doc.setTextColor(212, 175, 55); // Metallic Gold UI Mapping
  doc.setFontSize(22);
  doc.setFont("helvetica", "bold");
  doc.text("VROOMIE DIAGNOSTIC REPORT", 105, 20, { align: "center" });
  
  doc.setTextColor(200, 200, 200);
  doc.setFontSize(12);
  doc.setFont("helvetica", "italic");
  doc.text("Vehicle Health Check Analysis", 105, 28, { align: "center" });
  
  // --- 1. VEHICLE & SESSION INFO ---
  doc.setTextColor(0, 0, 0);
  doc.setFontSize(14);
  doc.setFont("helvetica", "bold");
  doc.text("1. VEHICLE & EXPORT INFO", 14, 50);
  
  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.text(`Vehicle ID/Name: ${vehicleId || 'Unknown Registration'}`, 14, 58);
  doc.text(`Report Generated On: ${dateStr}`, 14, 64);
  doc.text(`Total Lifetime Sessions Analyzed: ${historyData.length}`, 14, 70);
  
  // --- 2. RECURRENCE ANALYSIS (Very Important Section) ---
  doc.setFontSize(14);
  doc.setFont("helvetica", "bold");
  doc.text("2. PATTERN RECURRENCE ANALYSIS", 14, 85);
  
  const recurrenceBody = aggregatedTrends.map(t => [
    t.name,
    t.count.toString(),
    t.highestSeverity.toUpperCase(),
    t.trend,
    format(new Date(t.firstOccurrence), "MMM d, yyyy"),
    format(new Date(t.latestOccurrence), "MMM d, yyyy")
  ]);
  
  if (recurrenceBody.length > 0) {
    doc.autoTable({
      startY: 90,
      head: [['Anomaly Pattern', 'Occurrences', 'Peak Severity', 'Trend', 'First Noticed', 'Latest Trace']],
      body: recurrenceBody,
      theme: 'grid',
      headStyles: { fillColor: [212, 175, 55], textColor: [0, 0, 0] },
      margin: { left: 14, right: 14 }
    });
  } else {
    doc.setFontSize(10);
    doc.setFont("helvetica", "normal");
    doc.text("No mechanical pattern recurrences detected mechanically.", 14, 95);
  }
  
  // --- 3. ANALYSIS HISTORY ---
  const finalY = doc.lastAutoTable ? doc.lastAutoTable.finalY + 15 : 105;
  doc.setFontSize(14);
  doc.setFont("helvetica", "bold");
  doc.text("3. DETAILED LOG TIMELINE", 14, finalY);
  
  const historyBody = [];
  historyData.forEach(session => {
    const time = format(new Date(session.processed_at || session.created_date), "MMM d, yyyy - h:mm a");
    const status = (session.anomalies_detected && session.anomalies_detected.length > 0) 
      ? "\u203C ANOMALY DETECTED" // Fallback warning icon for jsPDF limits
      : "OK HEALTHY";
    const confidence = session.confidence_score ? `${session.confidence_score.toFixed(1)}%` : "N/A";
    
    if (session.anomalies_detected && session.anomalies_detected.length > 0) {
      session.anomalies_detected.forEach(anom => {
        historyBody.push([ time, status, anom.type, anom.severity.toUpperCase(), confidence ]);
      });
    } else {
      historyBody.push([ time, status, "None", "N/A", confidence ]);
    }
  });
  
  doc.autoTable({
    startY: finalY + 5,
    head: [['Timestamp', 'Session Results', 'Identified Sound Metric', 'Severity Level', 'Network Confidence']],
    body: historyBody,
    theme: 'grid',
    headStyles: { fillColor: [40, 40, 40] }
  });
  
  // --- 4. SYSTEM INSIGHTS & ACTIONS ---
  const insightsY = doc.lastAutoTable.finalY + 15;
  doc.setFontSize(14);
  doc.setFont("helvetica", "bold");
  doc.text("4. INTELLIGENCE & ADVICE", 14, insightsY);
  
  const hasCritical = aggregatedTrends.some(t => t.highestSeverity === 'critical' || t.highestSeverity === 'high');
  let insightText = hasCritical 
    ? "ACTION REQUIRED: Critical or High-severity mechanical anomalies definitively spotted.\nImmediate service routing and physical inspection recommended on isolated components."
    : aggregatedTrends.length > 0
    ? "MONITOR TRACES: Sub-critical anomalies are present. Monitor metric trends over 30 days."
    : "VERIFIED HEALTHY: Acoustic profiles functioning securely. Routine benchmarks pass gracefully.";
    
  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  const splitText = doc.splitTextToSize(insightText, 180);
  doc.text(splitText, 14, insightsY + 8);
  
  // Export!
  const safeId = (vehicleId || 'Diagnostics').replace(/[^a-z0-9]/gi, '_');
  const fileName = `Vroomie_Report_${safeId}_${format(new Date(), 'yyyy-MM-dd')}.pdf`;
  doc.save(fileName);
}

export function generateCSVReport(vehicleId, historyData) {
  let csvContent = "data:text/csv;charset=utf-8,";
  csvContent += "Timestamp,Session Status,Anomaly Name,Severity,Confidence\n";
  
  historyData.forEach(session => {
    const time = format(new Date(session.processed_at || session.created_date), "yyyy-MM-dd HH:mm:ss");
    const status = (session.anomalies_detected && session.anomalies_detected.length > 0) ? "Anomaly Detected" : "Healthy";
    const conf = session.confidence_score ? session.confidence_score.toFixed(1) : "";
    
    if (session.anomalies_detected && session.anomalies_detected.length > 0) {
      session.anomalies_detected.forEach(anom => {
        csvContent += `"${time}","${status}","${anom.type}","${anom.severity}","${conf}%"\n`;
      });
    } else {
      csvContent += `"${time}","${status}","None","","${conf}%"\n`;
    }
  });
  
  const safeId = (vehicleId || 'Diagnostics').replace(/[^a-z0-9]/gi, '_');
  const encodedUri = encodeURI(csvContent);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", `Vroomie_Report_${safeId}_${format(new Date(), 'yyyy-MM-dd')}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

export function generateSingleEntryPDFReport(entryData) {
  const doc = new jsPDF();
  const timeStr = entryData.processed_at 
    ? format(new Date(entryData.processed_at), "MMM d, yyyy - h:mm a")
    : format(new Date(entryData.created_date || new Date()), "MMM d, yyyy - h:mm a");
    
  const safeFilenameTime = format(new Date(entryData.processed_at || entryData.created_date || new Date()), "yyyy-MM-dd_HH-mm-ss");
  
  const hasAnomalies = entryData.anomalies_detected && entryData.anomalies_detected.length > 0;
  const primaryAnomaly = hasAnomalies ? entryData.anomalies_detected[0] : null;

  const renderPage = (currencyType, isFirstPage) => {
    if (!isFirstPage) {
      doc.addPage();
    }
    
    // --- HEADER ---
    doc.setFillColor(25, 25, 25);
    doc.rect(0, 0, 210, 40, 'F');
    
    doc.setTextColor(212, 175, 55);
    doc.setFontSize(22);
    doc.setFont("helvetica", "bold");
    doc.text("VROOMIE DIAGNOSTIC REPORT", 105, 20, { align: "center" });
    
    doc.setTextColor(200, 200, 200);
    doc.setFontSize(12);
    doc.setFont("helvetica", "italic");
    doc.text(`Analysis Type: Single Event Report (${currencyType} Costing)`, 105, 28, { align: "center" });

    // --- 1. TIMESTAMP & 2. STATUS ---
    doc.setTextColor(0, 0, 0);
    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.text("1. EVENT OVERVIEW", 14, 50);

    doc.setFontSize(10);
    doc.setFont("helvetica", "normal");
    doc.text(`Timestamp: ${timeStr}`, 14, 58);
    
    const dominantStatus = hasAnomalies 
      ? entryData.anomalies_detected.some(a => a.status === 'anomaly' || ['critical', 'high'].includes(a.severity)) 
        ? "!! ANOMALY DETECTED !!" 
        : "⚠️ POTENTIAL ANOMALY - UNCERTAIN" 
      : "OK - NO ANOMALY";
      
    doc.setFont("helvetica", "bold");
    if (dominantStatus.includes("ANOMALY DETECTED")) doc.setTextColor(220, 38, 38); // Red
    else if (dominantStatus.includes("POTENTIAL")) doc.setTextColor(202, 138, 4); // Yellow
    else doc.setTextColor(22, 163, 74); // Green
    
    doc.text(`Status: ${dominantStatus}`, 14, 66);

    // --- 3. ANOMALY DETAILS & 4. AUDIO MATCH INFO ---
    doc.setTextColor(0, 0, 0);
    doc.setFontSize(14);
    doc.text("2. DIAGNOSTIC DETAILS", 14, 80);

    doc.setFontSize(10);
    doc.setFont("helvetica", "normal");
    
    if (hasAnomalies) {
      doc.text(`Anomaly Name: ${primaryAnomaly.type}`, 14, 88);
      doc.text(`Severity Level: ${primaryAnomaly.severity.toUpperCase()}`, 14, 94);
      if (primaryAnomaly.description) {
        doc.text(`Description: ${primaryAnomaly.description}`, 14, 100);
      }
    } else {
      doc.text(`Anomaly Name: None`, 14, 88);
      doc.text(`Severity Level: N/A`, 14, 94);
    }
    
    doc.text(`Network Confidence: ${entryData.confidence_score ? entryData.confidence_score.toFixed(1) + '%' : 'N/A'}`, 14, 110);
    if (hasAnomalies && primaryAnomaly.matchedFile) {
        doc.text(`Matched Reference: ${primaryAnomaly.matchedFile}`, 14, 116);
    }

    // --- 5. SIGNAL DIAGNOSTICS & FIX / COST EST ---
    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.text("3. SYSTEM INTERPRETATION & ACTION", 14, 135);

    let insightText = "";
    if (hasAnomalies) {
      const sev = primaryAnomaly.severity;
      const dict = getDiagnosticMetadata(primaryAnomaly.type);
      
      const costStr = currencyType === 'USD' ? `$${dict.usd}` : `₹${dict.inr.toLocaleString()}`;
      
      if (sev === 'critical' || sev === 'high') {
        insightText = `SUGGESTED ACTION: IMMEDIATE CHECK REQUIRED.\nThis acoustic signature strongly correlates with severe engine breakdown.\n\nRecommended Fix: ${dict.fix}\nEstimated Cost: ${costStr}`;
      } else {
        insightText = `SUGGESTED ACTION: MONITOR / MINOR SERVICE.\nAcoustic anomalies detected but currently operating within secondary margins.\n\nRecommended Fix: ${dict.fix}\nEstimated Cost: ${costStr}`;
      }
    } else {
      insightText = "SUGGESTED ACTION: NONE.\nNo acoustic signatures of mechanical failure were matched.\nThe active engine block sounds perfectly healthy within normal operating frequency bands.";
    }

    doc.setFontSize(10);
    doc.setFont("helvetica", "normal");
    const splitText = doc.splitTextToSize(insightText, 180);
    doc.text(splitText, 14, 143);
  };

  // Render Page 1 (USD)
  renderPage('USD', true);
  
  // Render Page 2 (INR)
  if (hasAnomalies) {
    renderPage('INR', false);
  }

  const fileName = `Vroomie_Report_${safeFilenameTime}.pdf`;
  doc.save(fileName);
}
