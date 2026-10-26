// Response-time and call-history calculations for Analytics & Report.
// Pure functions, no React / Supabase — everything takes the arrays the
// Analytics page already holds (incidents from DispatcherLayout, call_logs
// from services/callLogs.js).
//
// Definitions used everywhere on the page:
//   time to view    = first_viewed_at - created_at
//   time to verify  = verified_at     - created_at
//   time to respond = responded_at    - created_at
// i.e. always measured from the moment the citizen submitted the report.

export const NOT_RECORDED = "Not recorded";

export const PERIODS = [
  { key: 7, label: "7 days" },
  { key: 30, label: "30 days" },
  { key: 90, label: "90 days" },
  { key: "all", label: "All time" },
];

// A ringing call this old with no end time can't still be ringing — the
// console that logged it was closed mid-call. Shown as missed / no answer.
const STALE_RINGING_MS = 2 * 60 * 1000;
// Same idea for a connected call that never got an ended_at.
const STALE_CONNECTED_MS = 3 * 60 * 60 * 1000;

export const OUTCOME_META = {
  ringing: { label: "Ringing", tone: "acknowledged" },
  connected: { label: "In progress", tone: "acknowledged" },
  completed: { label: "Completed", tone: "resolved" },
  missed: { label: "Missed", tone: "danger" },
  no_answer: { label: "No answer", tone: "danger" },
  declined: { label: "Declined", tone: "pending" },
  failed: { label: "Failed", tone: "danger" },
  interrupted: { label: "Interrupted", tone: "pending" },
};

// ---------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------

export function personName(p) {
  const name = [p?.first_name, p?.last_name].filter(Boolean).join(" ").trim();
  return name || null;
}

// 42s · 12m 05s · 3h 12m · 2d 4h
export function formatDuration(ms) {
  if (ms == null || Number.isNaN(ms)) return "—";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  if (hours < 24) return `${hours}h ${String(remMinutes).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

// Talk time as a call clock: 01:12 or 1:02:05
export function formatClock(seconds) {
  if (seconds == null) return "—";
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// With seconds — response times are measured to the second, so the
// timestamps next to them should be too.
export function formatDateTime(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

// ---------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------

const ms = (value) => (value ? new Date(value).getTime() : null);

// Elapsed ms between two timestamps, or null if either is missing or the
// result is negative (old rows stamped from a dispatcher PC's wrong clock).
function gap(from, to) {
  const a = typeof from === "number" ? from : ms(from);
  const b = typeof to === "number" ? to : ms(to);
  if (a == null || b == null || b < a) return null;
  return b - a;
}

export function average(values) {
  const nums = values.filter((v) => v != null && !Number.isNaN(v));
  return nums.length ? nums.reduce((sum, v) => sum + v, 0) / nums.length : null;
}

export function cutoffFor(period, now = Date.now()) {
  return period === "all" ? null : now - period * 24 * 60 * 60 * 1000;
}

export function withinPeriod(value, cutoff) {
  if (cutoff == null) return true;
  const t = ms(value);
  return t != null && t >= cutoff;
}

export function effectiveOutcome(call, now = Date.now()) {
  const age = now - (ms(call.started_at) ?? now);
  if (call.outcome === "ringing" && age > STALE_RINGING_MS) {
    return call.direction === "inbound" ? "missed" : "no_answer";
  }
  if (call.outcome === "connected" && !call.ended_at && age > STALE_CONNECTED_MS) return "interrupted";
  return call.outcome;
}

// Whether the response-tracking migration has been applied: once it has,
// every incident row carries the verified_by column (null or a value). With
// no incidents there's nothing to judge by, so assume it has.
export function trackingColumnsPresent(incidents) {
  return incidents.length === 0 || "verified_by" in incidents[0];
}

// ---------------------------------------------------------------
// Per-report response timeline
// ---------------------------------------------------------------

// One row per report: who viewed it, who called the citizen, who verified
// it, who marked it responded — each with the clock time and how long after
// the report came in.
export function buildResponseLog(incidents, callLogs) {
  // Earliest outbound call per report = the dispatcher's first contact.
  const firstCall = new Map();
  const outbound = callLogs
    .filter((c) => c.direction === "outbound" && c.incident_id != null)
    .sort((a, b) => new Date(a.started_at) - new Date(b.started_at));
  for (const call of outbound) {
    const key = String(call.incident_id);
    if (!firstCall.has(key)) firstCall.set(key, call);
  }

  return incidents.map((inc) => {
    const created = ms(inc.created_at);
    const call = firstCall.get(String(inc.id)) ?? null;

    const step = (at, by, byId) => ({
      at: at ?? null,
      by: at ? by ?? null : null,
      byId: byId ?? null,
      elapsed: at ? gap(created, ms(at)) : null,
    });

    const viewed = step(inc.first_viewed_at, personName(inc.viewer), inc.first_viewed_by);
    const verified = step(inc.verified_at, personName(inc.verifier), inc.verified_by);
    const responded = step(inc.responded_at, personName(inc.responder), inc.responded_by);
    const called = call
      ? {
          ...step(call.started_at, call.dispatcher_name, call.dispatcher_id),
          outcome: effectiveOutcome(call),
          talkSeconds: call.duration_seconds ?? null,
        }
      : null;

    return {
      id: inc.id,
      type: inc.incident_type || "Unspecified",
      isSOS: typeof inc.incident_type === "string" && inc.incident_type.startsWith("SOS:"),
      status: inc.status,
      reporter: personName(inc.profiles) || "Unknown citizen",
      municipality: inc.profiles?.municipality || "",
      createdAt: inc.created_at,
      viewed,
      called,
      verified,
      responded,
      toRespond: responded.elapsed,
      // Used by the dispatcher filter: anyone who touched the report.
      actorIds: [viewed.byId, called?.byId, verified.byId, responded.byId].filter(Boolean),
    };
  });
}

// ---------------------------------------------------------------
// Per-dispatcher summary
// ---------------------------------------------------------------

export function summarizeDispatchers(incidents, callLogs) {
  const byId = new Map();
  const ensure = (id, name, agency) => {
    if (!byId.has(id)) {
      byId.set(id, {
        id,
        name: name || "Unknown dispatcher",
        agency: agency || "",
        viewed: 0,
        verified: 0,
        responded: 0,
        verifyTimes: [],
        respondTimes: [],
        callsMade: 0,
        callsConnected: 0,
        citizenCallsAnswered: 0,
        pickupTimes: [],
        talkSeconds: [],
      });
    }
    const row = byId.get(id);
    if (name && row.name === "Unknown dispatcher") row.name = name;
    if (agency && !row.agency) row.agency = agency;
    return row;
  };

  for (const inc of incidents) {
    const created = ms(inc.created_at);
    if (inc.first_viewed_by) ensure(inc.first_viewed_by, personName(inc.viewer), inc.viewer?.agency).viewed += 1;
    if (inc.verified_by && inc.verified_at) {
      const row = ensure(inc.verified_by, personName(inc.verifier), inc.verifier?.agency);
      row.verified += 1;
      row.verifyTimes.push(gap(created, ms(inc.verified_at)));
    }
    if (inc.responded_by && inc.responded_at) {
      const row = ensure(inc.responded_by, personName(inc.responder), inc.responder?.agency);
      row.responded += 1;
      row.respondTimes.push(gap(created, ms(inc.responded_at)));
    }
  }

  for (const call of callLogs) {
    if (!call.dispatcher_id) continue;
    const row = ensure(call.dispatcher_id, call.dispatcher_name, "");
    if (call.direction === "outbound") {
      row.callsMade += 1;
      if (call.answered_at) row.callsConnected += 1;
    } else if (call.answered_at) {
      row.citizenCallsAnswered += 1;
      row.pickupTimes.push(gap(call.started_at, call.answered_at));
    }
    if (call.duration_seconds != null) row.talkSeconds.push(call.duration_seconds);
  }

  return [...byId.values()]
    .map((row) => {
      const respond = row.respondTimes.filter((v) => v != null);
      return {
        ...row,
        avgVerify: average(row.verifyTimes),
        avgRespond: average(row.respondTimes),
        fastestRespond: respond.length ? Math.min(...respond) : null,
        slowestRespond: respond.length ? Math.max(...respond) : null,
        avgPickup: average(row.pickupTimes),
        avgTalkSeconds: average(row.talkSeconds),
      };
    })
    .sort((a, b) => b.verified + b.responded + b.callsMade - (a.verified + a.responded + a.callsMade) || a.name.localeCompare(b.name));
}

// Overall figures across every report in view — including ones handled
// before dispatcher tracking existed, which have times but no name.
export function overallResponse(incidents) {
  const verify = [];
  const respond = [];
  for (const inc of incidents) {
    const created = ms(inc.created_at);
    if (inc.verified_at) verify.push(gap(created, ms(inc.verified_at)));
    if (inc.responded_at) respond.push(gap(created, ms(inc.responded_at)));
  }
  return {
    avgVerify: average(verify),
    avgRespond: average(respond),
    respondedCount: respond.filter((v) => v != null).length,
  };
}

export function overallCalls(callLogs) {
  const inbound = callLogs.filter((c) => c.direction === "inbound");
  const outbound = callLogs.filter((c) => c.direction === "outbound");
  return {
    total: callLogs.length,
    inbound: inbound.length,
    outbound: outbound.length,
    inboundAnswered: inbound.filter((c) => c.answered_at).length,
    inboundMissed: inbound.filter((c) => effectiveOutcome(c) === "missed").length,
    avgPickup: average(inbound.filter((c) => c.answered_at).map((c) => gap(c.started_at, c.answered_at))),
    avgTalkSeconds: average(callLogs.map((c) => c.duration_seconds)),
  };
}

// Seconds the caller waited before pickup (or before giving up). For an
// inbound call that's the citizen waiting on a dispatcher; for an outbound
// call it's the dispatcher waiting on the citizen.
export function ringTime(call) {
  return gap(call.started_at, call.answered_at ?? call.ended_at);
}
