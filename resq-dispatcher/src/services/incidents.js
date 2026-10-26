import { supabase } from "../lib/supabase";

// Same status values written by the citizen app (resq-partido/src/services/incidents.js):
// pending -> just reported | acknowledged -> dispatcher verified it's real | resolved -> responded to
export const STATUS = {
  pending: { label: "Pending", className: "pending" },
  acknowledged: { label: "Verified", className: "acknowledged" },
  resolved: { label: "Responded", className: "resolved" },
};

const BASE_SELECT = "*, incident_media(*), profiles:user_id(first_name,last_name,municipality,phone)";

// Which dispatcher viewed / verified / responded (columns added by
// supabase/response_tracking_schema.sql), joined to their name for the
// Analytics & Report > Dispatcher Response Times tab.
const TRACKED_SELECT =
  BASE_SELECT +
  ", viewer:first_viewed_by(first_name,last_name,agency)" +
  ", verifier:verified_by(first_name,last_name,agency)" +
  ", responder:responded_by(first_name,last_name,agency)";

export async function getAllIncidents({ status } = {}) {
  const run = (select) => {
    let query = supabase.from("incidents").select(select).order("created_at", { ascending: false });
    if (status && status !== "all") query = query.eq("status", status);
    return query;
  };

  let { data, error } = await run(TRACKED_SELECT);
  if (error) {
    // The tracking columns don't exist yet (response_tracking_schema.sql
    // hasn't been run). Fall back to the original query so every other
    // screen keeps working; Analytics & Report shows a setup notice.
    ({ data, error } = await run(BASE_SELECT));
  }
  if (error) throw error;
  return data;
}

async function currentUserId() {
  const { data } = await supabase.auth.getSession();
  return data.session?.user?.id ?? null;
}

// Records WHEN and by WHOM: verified_at/verified_by on "Verify",
// responded_at/responded_by on "Mark Responded". Response time on the
// analytics page is measured from the report's created_at to these.
export async function updateIncidentStatus(id, status) {
  const now = new Date().toISOString();
  const dispatcherId = await currentUserId();
  const patch = { status };
  const tracking = {};
  if (status === "acknowledged") {
    patch.verified_at = now;
    tracking.verified_by = dispatcherId;
  }
  if (status === "resolved") {
    patch.responded_at = now;
    tracking.responded_by = dispatcherId;
  }

  let { data, error } = await supabase
    .from("incidents")
    .update({ ...patch, ...tracking })
    .eq("id", id)
    .select()
    .single();
  if (error && Object.keys(tracking).length) {
    // Tracking columns missing (migration not run yet) — still do the status change.
    ({ data, error } = await supabase.from("incidents").update(patch).eq("id", id).select().single());
  }
  if (error) throw error;
  return data;
}

// First time a dispatcher opens a report that's still open. Only ever
// written once (the .is(null) guard), so it's the "first looked at" time,
// not the latest.
export async function markIncidentViewed(id) {
  const dispatcherId = await currentUserId();
  if (!dispatcherId) return;
  try {
    await supabase
      .from("incidents")
      .update({ first_viewed_at: new Date().toISOString(), first_viewed_by: dispatcherId })
      .eq("id", id)
      .is("first_viewed_at", null);
  } catch {
    // Best-effort — viewing a report must never fail because of tracking.
  }
}

// Fires `callback` on INSERT/UPDATE/DELETE to public.incidents so every
// screen stays in sync the moment a citizen submits or a dispatcher acts.
export function subscribeToIncidents(callback) {
  const channel = supabase
    .channel("dispatcher-incidents")
    .on("postgres_changes", { event: "*", schema: "public", table: "incidents" }, callback)
    .subscribe();
  return () => supabase.removeChannel(channel);
}

export function summarize(incidents) {
  const counts = { pending: 0, acknowledged: 0, resolved: 0, total: incidents.length };
  const byType = {};
  for (const inc of incidents) {
    counts[inc.status] = (counts[inc.status] ?? 0) + 1;
    // Group "SOS: Fire" together with plain "Fire" reports so the chart
    // reflects the underlying emergency type, not how it was filed.
    const type = (inc.incident_type || "").replace(/^SOS:\s*/, "") || "Unspecified";
    byType[type] = (byType[type] ?? 0) + 1;
  }
  const incidentTypeData = Object.entries(byType)
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);
  return { counts, incidentTypeData };
}

// Daily counts for the last `days` days, split by status — used by the
// Reports Overview / Analytics charts.
export function dailyTrend(incidents, days = 14) {
  const buckets = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    buckets.push({
      date: key,
      label: d.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      pending: 0,
      acknowledged: 0,
      resolved: 0,
      total: 0,
    });
  }
  const byKey = Object.fromEntries(buckets.map((b) => [b.date, b]));
  for (const inc of incidents) {
    const key = (inc.created_at || "").slice(0, 10);
    const bucket = byKey[key];
    if (!bucket) continue;
    bucket[inc.status] = (bucket[inc.status] ?? 0) + 1;
    bucket.total += 1;
  }
  return buckets;
}
