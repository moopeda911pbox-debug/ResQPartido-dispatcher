import { supabase } from "./supabase";

// Jurisdiction = the municipality where an emergency physically is (decided
// by the database from GPS coordinates — see supabase/jurisdiction_schema.sql),
// not the municipality on the citizen's account. A dispatcher handles reports
// in their own municipality; reports that couldn't be placed (outside the five
// municipalities, or no GPS) have jurisdiction null and go to everyone.

const norm = (value) => String(value ?? "").trim().toLowerCase();

export function sameMunicipality(a, b) {
  return !!norm(a) && norm(a) === norm(b);
}

// Mirrors public.can_access_jurisdiction() in the database. The database is
// what actually enforces it for reports; this is for things that never touch
// the database first, like a live citizen call arriving on a broadcast channel.
export function inMyJurisdiction(profile, jurisdiction) {
  if (profile?.role === "admin") return true;
  if (jurisdiction == null) return true; // unplaced: every dispatcher sees it
  return sameMunicipality(profile?.municipality, jurisdiction);
}

// Which municipality is this point in? Resolves to a municipality name, or
// null if it's outside all of them. Rejects if the lookup itself failed (e.g.
// the migration hasn't been run) — callers decide what failing means.
export async function jurisdictionAt(lat, lng) {
  const { data, error } = await supabase.rpc("jurisdiction_at", { p_lat: lat, p_lng: lng });
  if (error) throw error;
  return data ?? null;
}

// Where the report came from, when that differs from the reporter's home.
// "San Jose resident reporting from Goa" -> "San Jose"; otherwise null.
export function visitingFrom(incident) {
  const home = incident?.profiles?.municipality;
  const here = incident?.jurisdiction;
  return home && here && !sameMunicipality(home, here) ? home : null;
}
