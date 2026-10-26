import { supabase } from "../lib/supabase";

// Persistent call history (public.call_logs — see
// supabase/response_tracking_schema.sql).
//
// Every writer here is best-effort, same philosophy as lib/callPush.js: a
// failed log write must never block, delay or break a live call, so errors
// are swallowed. The Analytics page reports a missing table separately when
// it reads (getCallLogs).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOrNull = (v) => (typeof v === "string" && UUID_RE.test(v) ? v : null);

// call_logs.jurisdiction is added by supabase/jurisdiction_schema.sql. If a
// console is updated before that migration is run, the write is retried
// without it so call logging keeps working in the meantime.
async function writeWithJurisdictionFallback(write, row) {
  const first = await write(row);
  if (first?.error && "jurisdiction" in row) {
    const { jurisdiction, ...withoutIt } = row; // eslint-disable-line no-unused-vars
    return write(withoutIt);
  }
  return first;
}

// ---------------------------------------------------------------
// Outbound — a dispatcher calls a citizen (usually from a report).
// ---------------------------------------------------------------

// Resolves to the new row's id, or null if logging failed. The caller keeps
// the promise and chains later updates onto it so they can't race the insert.
export async function logOutboundCallStart({
  dispatcherId,
  dispatcherName,
  citizenId,
  citizenName,
  incidentId,
  incidentType,
  municipality,
  jurisdiction,
}) {
  try {
    const { data, error } = await writeWithJurisdictionFallback(
      (row) => supabase.from("call_logs").insert(row).select("id").single(),
      {
        direction: "outbound",
        dispatcher_id: uuidOrNull(dispatcherId),
        dispatcher_name: dispatcherName ?? null,
        citizen_id: uuidOrNull(citizenId),
        citizen_name: citizenName ?? null,
        incident_id: incidentId ?? null,
        incident_type: incidentType ?? null,
        municipality: municipality ?? null,
        jurisdiction: jurisdiction ?? null,
        outcome: "ringing",
      }
    );
    if (error) return null;
    return data.id;
  } catch {
    return null;
  }
}

export async function updateCallLog(id, patch) {
  try {
    await supabase.from("call_logs").update(patch).eq("id", id);
  } catch {
    // Best-effort.
  }
}

// ---------------------------------------------------------------
// Inbound — a citizen calls in; whichever dispatcher answers first takes it.
//
// Every signed-in dispatcher console hears the same ring, so they all try to
// log it. call_ref (the citizen app's callId) is unique, and the insert
// ignores duplicates, so exactly one row results no matter how many consoles
// are open.
// ---------------------------------------------------------------

export async function logInboundRing(call) {
  if (!call?.callId) return;
  try {
    await writeWithJurisdictionFallback(
      (row) => supabase.from("call_logs").upsert(row, { onConflict: "call_ref", ignoreDuplicates: true }),
      {
        call_ref: String(call.callId),
        direction: "inbound",
        citizen_id: uuidOrNull(call.citizenId),
        citizen_name: call.name ?? null,
        incident_type: call.incidentType ?? null,
        municipality: call.municipality ?? null,
        jurisdiction: call.jurisdiction ?? null,
        outcome: "ringing",
      }
    );
  } catch {
    // Best-effort.
  }
}

// The citizen gave up, or nobody picked up in time. Only touches a call that
// is still ringing, so a late "cancelled" can't overwrite one that was
// actually answered.
export async function markInboundMissed(callId) {
  if (!callId) return;
  try {
    await supabase
      .from("call_logs")
      .update({ outcome: "missed", ended_at: new Date().toISOString() })
      .eq("call_ref", String(callId))
      .eq("outcome", "ringing");
  } catch {
    // Best-effort.
  }
}

export async function logInboundAnswered(call, dispatcher) {
  if (!call?.callId) return;
  const patch = {
    dispatcher_id: uuidOrNull(dispatcher?.id),
    dispatcher_name: dispatcher?.name ?? null,
    answered_at: new Date().toISOString(),
    ended_at: null, // a ring timeout may have marked it missed a moment before pickup
    outcome: "connected",
  };
  try {
    const { data, error } = await supabase
      .from("call_logs")
      .update(patch)
      .eq("call_ref", String(call.callId))
      .select("id");
    if (!error && data?.length) return;

    // The ring row doesn't exist yet (this console's ring insert lost the
    // race or failed) — create it now, answered.
    await writeWithJurisdictionFallback(
      (row) => supabase.from("call_logs").upsert(row, { onConflict: "call_ref" }),
      {
        call_ref: String(call.callId),
        direction: "inbound",
        citizen_id: uuidOrNull(call.citizenId),
        citizen_name: call.name ?? null,
        incident_type: call.incidentType ?? null,
        municipality: call.municipality ?? null,
        jurisdiction: call.jurisdiction ?? null,
        started_at: call.receivedAt ? new Date(call.receivedAt).toISOString() : new Date().toISOString(),
        ...patch,
      }
    );
  } catch {
    // Best-effort.
  }
}

export async function finishInboundCall(callId, { endedAt, durationSeconds, outcome }) {
  if (!callId) return;
  try {
    await supabase
      .from("call_logs")
      .update({
        ended_at: endedAt.toISOString(),
        duration_seconds: durationSeconds,
        outcome,
      })
      .eq("call_ref", String(callId));
  } catch {
    // Best-effort.
  }
}

// ---------------------------------------------------------------
// Reading — Analytics & Report > Call History / Dispatcher Response Times.
// ---------------------------------------------------------------

export async function getCallLogs({ limit = 1000 } = {}) {
  const { data, error } = await supabase
    .from("call_logs")
    .select("*")
    .order("started_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data;
}

export function subscribeToCallLogs(callback) {
  const channel = supabase
    .channel("dispatcher-call-logs")
    .on("postgres_changes", { event: "*", schema: "public", table: "call_logs" }, callback)
    .subscribe();
  return () => supabase.removeChannel(channel);
}
