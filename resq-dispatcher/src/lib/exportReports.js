import * as XLSX from "xlsx";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import {
  NOT_RECORDED,
  OUTCOME_META,
  effectiveOutcome,
  ringTime,
  formatDuration,
  formatClock,
  formatDateTime,
} from "./responseMetrics";

const BRAND_ORANGE = [224, 83, 10];
const BRAND_NAVY = [15, 37, 69];

function timestamp() {
  return new Date().toISOString().slice(0, 10);
}

// Prevents CSV/Excel formula injection: if a citizen-submitted field
// (description, address, name) starts with =, +, -, or @, Excel may try
// to evaluate it as a formula when a dispatcher opens the exported file.
// Prefixing with a straight quote makes Excel treat it as plain text.
function sheetSafe(value) {
  const str = value == null ? "" : String(value);
  return /^[=+\-@]/.test(str) ? `'${str}` : str;
}

function reporterName(inc) {
  const p = inc.profiles;
  const name = [p?.first_name, p?.last_name].filter(Boolean).join(" ").trim();
  return name || "Unknown";
}

function incidentRow(inc) {
  return {
    Type: sheetSafe(inc.incident_type),
    Description: sheetSafe(inc.description),
    "Reported By": sheetSafe(reporterName(inc)),
    Municipality: sheetSafe(inc.profiles?.municipality || ""),
    Status: sheetSafe(inc.status),
    Submitted: inc.created_at ? new Date(inc.created_at).toLocaleString() : "",
    Verified: inc.verified_at ? new Date(inc.verified_at).toLocaleString() : "",
    Responded: inc.responded_at ? new Date(inc.responded_at).toLocaleString() : "",
    Latitude: inc.latitude ?? "",
    Longitude: inc.longitude ?? "",
    Address: sheetSafe(inc.address ?? ""),
  };
}

function docHeader(doc, title, subtitle) {
  doc.setFontSize(14);
  doc.setTextColor(...BRAND_NAVY);
  doc.text(title, 14, 16);
  if (subtitle) {
    doc.setFontSize(9);
    doc.setTextColor(120);
    doc.text(subtitle, 14, 22);
  }
  return subtitle ? 27 : 22;
}

// ---------------------------------------------------------------
// Manage Reports — export the incident list (respects whatever
// filter/tab is currently applied on screen, since callers pass in
// the already-filtered array).
// ---------------------------------------------------------------

export function exportIncidentsToExcel(incidents, { filename, sheetName = "Reports" } = {}) {
  const rows = incidents.map(incidentRow);
  const ws = XLSX.utils.json_to_sheet(rows);
  ws["!cols"] = [
    { wch: 18 }, { wch: 40 }, { wch: 18 }, { wch: 14 }, { wch: 12 },
    { wch: 20 }, { wch: 20 }, { wch: 20 }, { wch: 11 }, { wch: 11 }, { wch: 30 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
  XLSX.writeFile(wb, filename || `resqpartido-reports-${timestamp()}.xlsx`);
}

export function exportIncidentsToPDF(incidents, { filename, title = "ResQPartido — Incident Reports", subtitle } = {}) {
  const doc = new jsPDF({ orientation: "landscape" });
  const startY = docHeader(doc, title, subtitle || `Generated ${new Date().toLocaleString()} · ${incidents.length} reports`);

  autoTable(doc, {
    startY,
    head: [["Type", "Description", "Reported By", "Municipality", "Status", "Submitted"]],
    body: incidents.map((inc) => [
      inc.incident_type,
      (inc.description || "").slice(0, 90),
      reporterName(inc),
      inc.profiles?.municipality || "",
      inc.status,
      inc.created_at ? new Date(inc.created_at).toLocaleString() : "",
    ]),
    styles: { fontSize: 8, cellPadding: 3 },
    headStyles: { fillColor: BRAND_ORANGE, textColor: 255 },
    alternateRowStyles: { fillColor: [249, 249, 249] },
  });

  doc.save(filename || `resqpartido-reports-${timestamp()}.pdf`);
}

// ---------------------------------------------------------------
// Analytics & Report — export the summary stats + chart data
// currently shown on screen.
// ---------------------------------------------------------------

export function exportAnalyticsToExcel({ counts, incidentTypeData, trend, municipalityData }, { filename } = {}) {
  const wb = XLSX.utils.book_new();

  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet([
      { Metric: "Total Reports", Value: counts.total },
      { Metric: "Pending", Value: counts.pending },
      { Metric: "Verified", Value: counts.acknowledged },
      { Metric: "Responded", Value: counts.resolved },
    ]),
    "Summary"
  );

  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(incidentTypeData.map((d) => ({ Type: d.type, Count: d.count }))),
    "Incident Types"
  );

  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(municipalityData.map((d) => ({ Municipality: d.type, Count: d.count }))),
    "By Municipality"
  );

  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      trend.map((d) => ({
        Date: d.label,
        Pending: d.pending,
        Verified: d.acknowledged,
        Responded: d.resolved,
        Total: d.total,
      }))
    ),
    "Daily Trend"
  );

  XLSX.writeFile(wb, filename || `resqpartido-analytics-${timestamp()}.xlsx`);
}

export function exportAnalyticsToPDF(
  { counts, incidentTypeData, trend, municipalityData },
  { filename, rangeLabel } = {}
) {
  const doc = new jsPDF({ orientation: "landscape" });
  let y = docHeader(
    doc,
    "ResQPartido — Analytics & Report",
    `Generated ${new Date().toLocaleString()}${rangeLabel ? ` · Trend range: ${rangeLabel}` : ""}`
  );

  autoTable(doc, {
    startY: y,
    head: [["Metric", "Value"]],
    body: [
      ["Total Reports", counts.total],
      ["Pending", counts.pending],
      ["Verified", counts.acknowledged],
      ["Responded", counts.resolved],
    ],
    styles: { fontSize: 9 },
    headStyles: { fillColor: BRAND_ORANGE, textColor: 255 },
    tableWidth: 100,
  });

  y = doc.lastAutoTable.finalY + 12;
  doc.setFontSize(11);
  doc.setTextColor(...BRAND_NAVY);
  doc.text("Incident Types", 14, y);
  autoTable(doc, {
    startY: y + 4,
    head: [["Type", "Count"]],
    body: incidentTypeData.map((d) => [d.type, d.count]),
    styles: { fontSize: 8 },
    headStyles: { fillColor: BRAND_ORANGE, textColor: 255 },
    tableWidth: 100,
  });

  y = doc.lastAutoTable.finalY + 12;
  doc.text("Reports by Municipality", 14, y);
  autoTable(doc, {
    startY: y + 4,
    head: [["Municipality", "Count"]],
    body: municipalityData.map((d) => [d.type, d.count]),
    styles: { fontSize: 8 },
    headStyles: { fillColor: BRAND_ORANGE, textColor: 255 },
    tableWidth: 100,
  });

  doc.addPage();
  doc.setFontSize(12);
  doc.setTextColor(...BRAND_NAVY);
  doc.text("Reports Over Time", 14, 16);
  autoTable(doc, {
    startY: 22,
    head: [["Date", "Pending", "Verified", "Responded", "Total"]],
    body: trend.map((d) => [d.label, d.pending, d.acknowledged, d.resolved, d.total]),
    styles: { fontSize: 8 },
    headStyles: { fillColor: BRAND_ORANGE, textColor: 255 },
  });

  doc.save(filename || `resqpartido-analytics-${timestamp()}.pdf`);
}

// ---------------------------------------------------------------
// Analytics & Report > Dispatcher Response Times — the per-dispatcher
// summary plus the per-report timeline, as currently filtered on screen.
// ---------------------------------------------------------------

function stepText(step) {
  if (!step?.at) return "";
  const who = step.by || NOT_RECORDED;
  const elapsed = step.elapsed != null ? ` (+${formatDuration(step.elapsed)})` : "";
  return `${who} · ${formatDateTime(step.at)}${elapsed}`;
}

function dispatcherRow(d) {
  return {
    Dispatcher: sheetSafe(d.name),
    Agency: sheetSafe(d.agency),
    Viewed: d.viewed,
    Verified: d.verified,
    "Avg. time to verify": formatDuration(d.avgVerify),
    Responded: d.responded,
    "Avg. time to respond": formatDuration(d.avgRespond),
    Fastest: formatDuration(d.fastestRespond),
    Slowest: formatDuration(d.slowestRespond),
    "Calls made": d.callsMade,
    "Calls connected": d.callsConnected,
    "Citizen calls answered": d.citizenCallsAnswered,
    "Avg. pick-up time": formatDuration(d.avgPickup),
    "Avg. talk time": formatClock(d.avgTalkSeconds),
  };
}

function timelineRow(r) {
  return {
    Type: sheetSafe(r.type),
    "Reported By": sheetSafe(r.reporter),
    Municipality: sheetSafe(r.municipality),
    Submitted: r.createdAt ? new Date(r.createdAt).toLocaleString() : "",
    "Viewed By": sheetSafe(r.viewed.at ? r.viewed.by || NOT_RECORDED : ""),
    "Viewed At": r.viewed.at ? new Date(r.viewed.at).toLocaleString() : "",
    "Time to View": r.viewed.at ? formatDuration(r.viewed.elapsed) : "",
    "Called By": sheetSafe(r.called ? r.called.by || NOT_RECORDED : ""),
    "Called At": r.called ? new Date(r.called.at).toLocaleString() : "",
    "Call Outcome": r.called ? OUTCOME_META[r.called.outcome]?.label ?? r.called.outcome : "",
    "Call Talk Time": r.called ? formatClock(r.called.talkSeconds) : "",
    "Verified By": sheetSafe(r.verified.at ? r.verified.by || NOT_RECORDED : ""),
    "Verified At": r.verified.at ? new Date(r.verified.at).toLocaleString() : "",
    "Time to Verify": r.verified.at ? formatDuration(r.verified.elapsed) : "",
    "Responded By": sheetSafe(r.responded.at ? r.responded.by || NOT_RECORDED : ""),
    "Responded At": r.responded.at ? new Date(r.responded.at).toLocaleString() : "",
    "Time to Respond": r.responded.at ? formatDuration(r.responded.elapsed) : "",
  };
}

export function exportResponseTimesToExcel({ dispatchers, log }, { filename } = {}) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(dispatchers.map(dispatcherRow)), "Per Dispatcher");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(log.map(timelineRow)), "Report Timeline");
  XLSX.writeFile(wb, filename || `resqpartido-response-times-${timestamp()}.xlsx`);
}

export function exportResponseTimesToPDF({ dispatchers, log }, { filename, periodLabel } = {}) {
  const doc = new jsPDF({ orientation: "landscape" });
  const startY = docHeader(
    doc,
    "ResQPartido — Dispatcher Response Times",
    `Generated ${new Date().toLocaleString()}${periodLabel ? ` · ${periodLabel}` : ""} · measured from when the citizen submitted the report`
  );

  autoTable(doc, {
    startY,
    head: [["Dispatcher", "Viewed", "Verified", "Avg. verify", "Responded", "Avg. respond", "Fastest", "Slowest", "Calls made", "Citizen calls answered", "Avg. pick-up"]],
    body: dispatchers.map((d) => [
      d.agency ? `${d.name} (${d.agency})` : d.name,
      d.viewed,
      d.verified,
      formatDuration(d.avgVerify),
      d.responded,
      formatDuration(d.avgRespond),
      formatDuration(d.fastestRespond),
      formatDuration(d.slowestRespond),
      d.callsMade,
      d.citizenCallsAnswered,
      formatDuration(d.avgPickup),
    ]),
    styles: { fontSize: 8, cellPadding: 3 },
    headStyles: { fillColor: BRAND_ORANGE, textColor: 255 },
    alternateRowStyles: { fillColor: [249, 249, 249] },
  });

  doc.addPage();
  doc.setFontSize(12);
  doc.setTextColor(...BRAND_NAVY);
  doc.text("Response Timeline per Report", 14, 16);
  autoTable(doc, {
    startY: 22,
    head: [["Report", "Submitted", "Viewed", "Called citizen", "Verified", "Responded", "Total"]],
    body: log.map((r) => [
      `${r.type}\n${r.reporter}`,
      r.createdAt ? new Date(r.createdAt).toLocaleString() : "",
      stepText(r.viewed),
      r.called ? `${stepText(r.called)}${r.called.talkSeconds != null ? ` · talked ${formatClock(r.called.talkSeconds)}` : ""}` : "",
      stepText(r.verified),
      stepText(r.responded),
      r.toRespond != null ? formatDuration(r.toRespond) : "",
    ]),
    styles: { fontSize: 7, cellPadding: 2 },
    headStyles: { fillColor: BRAND_ORANGE, textColor: 255 },
    alternateRowStyles: { fillColor: [249, 249, 249] },
  });

  doc.save(filename || `resqpartido-response-times-${timestamp()}.pdf`);
}

// ---------------------------------------------------------------
// Analytics & Report > Call History — respects the tab / dispatcher /
// search filters currently applied (callers pass the filtered rows).
// ---------------------------------------------------------------

function callRow(c) {
  const outcome = effectiveOutcome(c);
  return {
    Started: c.started_at ? new Date(c.started_at).toLocaleString() : "",
    Ended: c.ended_at ? new Date(c.ended_at).toLocaleString() : "",
    Type: c.direction === "inbound" ? "Citizen called" : "Dispatcher called",
    Citizen: sheetSafe(c.citizen_name || "Unknown citizen"),
    Municipality: sheetSafe(c.municipality || ""),
    Dispatcher: sheetSafe(c.dispatcher_name || "Nobody picked up"),
    Regarding: sheetSafe(c.incident_type || "General call"),
    "Ring Time": formatDuration(ringTime(c)),
    "Talk Time": formatClock(c.duration_seconds),
    Outcome: OUTCOME_META[outcome]?.label ?? outcome,
  };
}

export function exportCallHistoryToExcel(calls, { filename, sheetName = "Call History" } = {}) {
  const ws = XLSX.utils.json_to_sheet(calls.map(callRow));
  ws["!cols"] = [{ wch: 20 }, { wch: 20 }, { wch: 17 }, { wch: 22 }, { wch: 14 }, { wch: 22 }, { wch: 20 }, { wch: 10 }, { wch: 10 }, { wch: 12 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
  XLSX.writeFile(wb, filename || `resqpartido-call-history-${timestamp()}.xlsx`);
}

export function exportCallHistoryToPDF(calls, { filename, periodLabel, viewLabel } = {}) {
  const doc = new jsPDF({ orientation: "landscape" });
  const startY = docHeader(
    doc,
    "ResQPartido — Call History",
    `${viewLabel ? `${viewLabel} · ` : ""}${periodLabel ? `${periodLabel} · ` : ""}Generated ${new Date().toLocaleString()} · ${calls.length} calls`
  );

  autoTable(doc, {
    startY,
    head: [["Started", "Type", "Citizen", "Dispatcher", "Regarding", "Ring time", "Talk time", "Outcome"]],
    body: calls.map((c) => {
      const row = callRow(c);
      return [row.Started, row.Type, row.Citizen, row.Dispatcher, row.Regarding, row["Ring Time"], row["Talk Time"], row.Outcome];
    }),
    styles: { fontSize: 8, cellPadding: 3 },
    headStyles: { fillColor: BRAND_ORANGE, textColor: 255 },
    alternateRowStyles: { fillColor: [249, 249, 249] },
  });

  doc.save(filename || `resqpartido-call-history-${timestamp()}.pdf`);
}
