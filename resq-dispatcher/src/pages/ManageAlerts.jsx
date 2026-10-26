import React, { useMemo, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { AlertTriangle, CheckCircle2, ShieldCheck } from "lucide-react";
import StatCard from "../components/StatCard";
import IncidentMap from "../components/IncidentMap";
import { STATUS, updateIncidentStatus } from "../services/incidents";

export default function ManageAlerts() {
  const { incidents, loading, refresh } = useOutletContext();
  const [selectedId, setSelectedId] = useState(null);
  const [acting, setActing] = useState(null);
  const active = useMemo(
    () => incidents.filter((i) => i.status !== "resolved").sort((a, b) => new Date(b.created_at) - new Date(a.created_at)),
    [incidents]
  );
  const pendingCount = incidents.filter((i) => i.status === "pending").length;
  const verifiedCount = incidents.filter((i) => i.status === "acknowledged").length;
  const resolvedToday = incidents.filter(
    (i) => i.status === "resolved" && (i.responded_at || i.created_at)?.slice(0, 10) === new Date().toISOString().slice(0, 10)
  ).length;

  async function act(id, status) {
    setActing(id);
    try {
      await updateIncidentStatus(id, status);
      await refresh();
    } finally {
      setActing(null);
    }
  }

  if (loading) return <p className="empty-state">Loading live reports…</p>;

  return (
    <>
      <div className="stat-grid">
        <StatCard icon={AlertTriangle} label="Active Alerts" value={pendingCount} tone="orange" />
        <StatCard icon={ShieldCheck} label="Verified, In Progress" value={verifiedCount} tone="info" />
        <StatCard icon={CheckCircle2} label="Resolved Today" value={resolvedToday} tone="success" />
      </div>

      <div className="two-col" style={{ alignItems: "start" }}>
        <div className="panel">
          <div className="panel-header">
            <h2>Live Map</h2>
            <span className="sub">OpenStreetMap · pinned from the citizen app's GPS location</span>
          </div>
          <IncidentMap incidents={active} selectedId={selectedId} onSelect={setSelectedId} />
          <div className="map-legend">
            <span className="item"><span className="dot" style={{ background: "#f0a93a" }} /> Pending</span>
            <span className="item"><span className="dot" style={{ background: "#2f7cf6" }} /> Verified</span>
            <span className="item"><span className="dot" style={{ background: "#20c96b" }} /> Responded</span>
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <h2>Current Alerts</h2>
            <span className="sub">{active.length} active</span>
          </div>
          <div className="alert-list">
            {active.length === 0 && <div className="empty-state">No active alerts right now.</div>}
            {active.map((inc) => (
              <div
                key={inc.id}
                className={`alert-item${selectedId === inc.id ? " selected" : ""}`}
                onClick={() => setSelectedId(inc.id)}
              >
                <div className="row1">
                  <span className="type">{inc.incident_type}</span>
                  <span className="time">{new Date(inc.created_at).toLocaleString()}</span>
                </div>
                <p className="desc">{inc.description}</p>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span className={`status-pill ${STATUS[inc.status].className}`}>{STATUS[inc.status].label}</span>
                  <div>
                    {inc.status === "pending" && (
                      <button className="btn-mini primary" disabled={acting === inc.id} onClick={(e) => { e.stopPropagation(); act(inc.id, "acknowledged"); }}>
                        Verify
                      </button>
                    )}
                    {inc.status !== "resolved" && (
                      <button className="btn-mini success" disabled={acting === inc.id} onClick={(e) => { e.stopPropagation(); act(inc.id, "resolved"); }}>
                        Mark Responded
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
