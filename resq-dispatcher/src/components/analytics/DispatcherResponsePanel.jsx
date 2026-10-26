import React, { useMemo, useState } from "react";
import { Timer, ShieldCheck, CheckCircle2, Users } from "lucide-react";
import StatCard from "../StatCard";
import ExportMenu from "../ExportMenu";
import {
  NOT_RECORDED,
  PERIODS,
  OUTCOME_META,
  buildResponseLog,
  summarizeDispatchers,
  overallResponse,
  cutoffFor,
  withinPeriod,
  formatDuration,
  formatClock,
  formatDateTime,
} from "../../lib/responseMetrics";
import { exportResponseTimesToPDF, exportResponseTimesToExcel } from "../../lib/exportReports";

const PAGE = 50;

// One step of a report's timeline: who did it, the exact clock time, and how
// long after the citizen submitted the report.
function Step({ step, extra }) {
  if (!step?.at) return <span style={{ color: "var(--muted)" }}>—</span>;
  return (
    <div className="step-cell">
      {step.by ? <strong>{step.by}</strong> : <span className="unrecorded">{NOT_RECORDED}</span>}
      <div className="when">{formatDateTime(step.at)}</div>
      {step.elapsed != null && <span className="elapsed">+{formatDuration(step.elapsed)}</span>}
      {extra}
    </div>
  );
}

export default function DispatcherResponsePanel({ incidents, callLogs, trackingReady }) {
  const [period, setPeriod] = useState(30);
  const [dispatcherId, setDispatcherId] = useState("all");
  const [visible, setVisible] = useState(PAGE);

  const cutoff = cutoffFor(period);
  const periodLabel = PERIODS.find((p) => p.key === period)?.label ?? "";

  const scopedIncidents = useMemo(
    () => incidents.filter((i) => withinPeriod(i.created_at, cutoff)),
    [incidents, cutoff]
  );
  const scopedCalls = useMemo(() => callLogs.filter((c) => withinPeriod(c.started_at, cutoff)), [callLogs, cutoff]);

  const overall = useMemo(() => overallResponse(scopedIncidents), [scopedIncidents]);
  const dispatchers = useMemo(() => summarizeDispatchers(scopedIncidents, scopedCalls), [scopedIncidents, scopedCalls]);
  const log = useMemo(() => buildResponseLog(scopedIncidents, scopedCalls), [scopedIncidents, scopedCalls]);

  const filteredLog = useMemo(
    () => (dispatcherId === "all" ? log : log.filter((row) => row.actorIds.includes(dispatcherId))),
    [log, dispatcherId]
  );
  const shown = filteredLog.slice(0, visible);

  function changePeriod(key) {
    setPeriod(key);
    setVisible(PAGE);
  }

  function handleExportPdf() {
    exportResponseTimesToPDF({ dispatchers, log: filteredLog }, { periodLabel });
  }
  function handleExportExcel() {
    exportResponseTimesToExcel({ dispatchers, log: filteredLog });
  }

  return (
    <>
      {!trackingReady && (
        <div className="notice">
          <strong>Dispatcher tracking isn't set up yet.</strong> Run <code>supabase/response_tracking_schema.sql</code> in
          the Supabase SQL editor. Until then, reports can't be tied to the dispatcher who verified or responded to them,
          so the names below will be missing.
        </div>
      )}

      <div className="panel">
        <div className="panel-header" style={{ flexWrap: "wrap", gap: 10 }}>
          <div>
            <h2>Dispatcher Response Times</h2>
            <span className="sub">Measured from the moment the citizen submitted the report</span>
          </div>
          <div className="filter-row">
            <div className="chip-row">
              {PERIODS.map((p) => (
                <button key={p.key} className={`chip${period === p.key ? " active" : ""}`} onClick={() => changePeriod(p.key)}>
                  {p.label}
                </button>
              ))}
            </div>
            <ExportMenu onExportPdf={handleExportPdf} onExportExcel={handleExportExcel} />
          </div>
        </div>

        <div className="stat-grid" style={{ marginBottom: 0 }}>
          <StatCard icon={ShieldCheck} label="Avg. time to verify" value={formatDuration(overall.avgVerify)} tone="info" />
          <StatCard icon={Timer} label="Avg. time to respond" value={formatDuration(overall.avgRespond)} tone="orange" />
          <StatCard icon={CheckCircle2} label="Reports responded" value={overall.respondedCount} tone="success" />
          <StatCard icon={Users} label="Active dispatchers" value={dispatchers.length} tone="navy" />
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">
          <h2>Per Dispatcher</h2>
          <span className="sub">{periodLabel}</span>
        </div>
        {dispatchers.length === 0 ? (
          <div className="empty-state">
            No dispatcher activity recorded in this period yet. Names appear once a dispatcher verifies, responds to, or
            calls about a report.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Dispatcher</th>
                  <th className="num">Viewed</th>
                  <th className="num">Verified</th>
                  <th className="num">Avg. to verify</th>
                  <th className="num">Responded</th>
                  <th className="num">Avg. to respond</th>
                  <th className="num">Fastest</th>
                  <th className="num">Slowest</th>
                  <th className="num">Calls made</th>
                  <th className="num">Citizen calls answered</th>
                  <th className="num">Avg. pick-up</th>
                  <th className="num">Avg. talk time</th>
                </tr>
              </thead>
              <tbody>
                {dispatchers.map((d) => (
                  <tr key={d.id}>
                    <td style={{ fontWeight: 700, whiteSpace: "nowrap" }}>
                      {d.name}
                      {d.agency && <div style={{ fontSize: 10.5, color: "var(--muted)", fontWeight: 600 }}>{d.agency}</div>}
                    </td>
                    <td className="num">{d.viewed}</td>
                    <td className="num">{d.verified}</td>
                    <td className="num">{formatDuration(d.avgVerify)}</td>
                    <td className="num">{d.responded}</td>
                    <td className="num" style={{ fontWeight: 700 }}>{formatDuration(d.avgRespond)}</td>
                    <td className="num">{formatDuration(d.fastestRespond)}</td>
                    <td className="num">{formatDuration(d.slowestRespond)}</td>
                    <td className="num">
                      {d.callsMade}
                      {d.callsMade > 0 && (
                        <div style={{ fontSize: 10.5, color: "var(--muted)" }}>{d.callsConnected} connected</div>
                      )}
                    </td>
                    <td className="num">{d.citizenCallsAnswered}</td>
                    <td className="num">{formatDuration(d.avgPickup)}</td>
                    <td className="num">{formatClock(d.avgTalkSeconds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel">
        <div className="panel-header" style={{ flexWrap: "wrap", gap: 10 }}>
          <div>
            <h2>Response Timeline per Report</h2>
            <span className="sub">
              Who viewed, called, verified and responded — with the exact time and how long after the report came in
            </span>
          </div>
          <div className="filter-row">
            <select
              value={dispatcherId}
              onChange={(e) => {
                setDispatcherId(e.target.value);
                setVisible(PAGE);
              }}
              aria-label="Filter by dispatcher"
            >
              <option value="all">All dispatchers</option>
              {dispatchers.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
            <span className="sub">{filteredLog.length} reports</span>
          </div>
        </div>

        {filteredLog.length === 0 ? (
          <div className="empty-state">No reports match this filter.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Report</th>
                  <th>Submitted</th>
                  <th>Viewed by</th>
                  <th>Called citizen</th>
                  <th>Verified by</th>
                  <th>Responded by</th>
                  <th className="num">Total response</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((row) => (
                  <tr key={row.id}>
                    <td style={{ whiteSpace: "nowrap" }}>
                      <strong>{row.type}</strong>
                      <div style={{ fontSize: 11.5 }}>{row.reporter}</div>
                      {row.municipality && <div style={{ fontSize: 10.5, color: "var(--muted)" }}>{row.municipality}</div>}
                    </td>
                    <td style={{ whiteSpace: "nowrap", fontSize: 11.5 }}>{formatDateTime(row.createdAt)}</td>
                    <td><Step step={row.viewed} /></td>
                    <td>
                      <Step
                        step={row.called}
                        extra={
                          row.called && (
                            <span className="extra">
                              {OUTCOME_META[row.called.outcome]?.label ?? row.called.outcome}
                              {row.called.talkSeconds != null && ` · talked ${formatClock(row.called.talkSeconds)}`}
                            </span>
                          )
                        }
                      />
                    </td>
                    <td><Step step={row.verified} /></td>
                    <td><Step step={row.responded} /></td>
                    <td className="num">
                      {row.toRespond != null ? (
                        <span className="total-time">{formatDuration(row.toRespond)}</span>
                      ) : (
                        <span className={`status-pill ${row.status === "pending" ? "pending" : "acknowledged"}`}>
                          {row.status === "pending" ? "Awaiting" : "In progress"}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filteredLog.length > visible && (
              <div className="table-more">
                <button className="btn-mini" onClick={() => setVisible((v) => v + PAGE)}>
                  Show more ({filteredLog.length - visible} remaining)
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
