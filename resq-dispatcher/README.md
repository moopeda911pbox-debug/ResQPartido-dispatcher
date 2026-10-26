# ResQPartido — Dispatcher Console

The dispatcher-side web app for BilisSaklolo/ResQPartido. It shares the **same
Supabase project** as the citizen app (`resq-partido`), so a report submitted
on a citizen's phone appears on this dashboard in real time — no polling, no
separate backend.

## How it connects to the citizen app

- Same tables: `incidents`, `incident_media`, `profiles` (see the citizen
  app's `supabase/schema.sql`).
- `supabase/dispatcher_schema.sql` adds what the citizen app's schema doesn't
  need on its own: a `role` column on `profiles`, RLS policies that let a
  `dispatcher`/`admin` account read *every* incident (citizens can only read
  their own), and turns on Supabase Realtime for the `incidents` table.
- Run the citizen app's `schema.sql` first, then this app's
  `dispatcher_schema.sql`, in the Supabase SQL editor.
- Promote an account to dispatcher:
  `update public.profiles set role = 'dispatcher' where email = '...';`
- Copy `.env.local.example` to `.env.local` and fill in the **same**
  `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` the citizen app uses.

## What's built

- **Dashboard** — Emergency Alerts / Pending / Responded / Total stat cards,
  an Incident Types bar chart, and a Reports Overview trend chart. Both
  charts are computed live from the `incidents` table, so they update
  automatically as reports come in — no manual data entry.
- **Manage Alerts** — a live Leaflet + OpenStreetMap view of every
  active (unresolved) incident, color-coded by status, plus a matching list
  you can click through. Verify / Mark Responded buttons write straight back
  to Supabase.
- **Manage Reports** — the full report log with All / Pending / Verified /
  Responded filter tabs, reporter name + municipality, and the same
  verify/respond actions.
- **Analytics & Report** — reports-over-time (7/14/30 day toggle), incident
  type breakdown, a status pie chart, and a by-municipality breakdown.
- **Realtime sync** — `src/services/incidents.js` opens one Supabase Realtime
  channel on `public.incidents`; every screen re-fetches the moment a row is
  inserted or updated, from either app.
- **Separate admin sign-in** — `/login` is the dispatcher console sign-in and
  only accepts `role = 'dispatcher'` accounts; `/admin/login` is a distinct
  page for `role = 'admin'` accounts only. Each rejects the other role with
  a message pointing to the right page (a link between the two pages does
  the same). Once signed in, an admin lands on Manage Accounts and still has
  the full dispatcher console in the sidebar, since `role = 'admin'` passes
  the same dispatcher-console access checks a dispatcher account does.
- **Manage Accounts** *(admin only)* — a sidebar item that only shows up for
  `role = 'admin'` accounts. Lets an admin create dispatcher (or admin)
  accounts from the UI — picking the responding agency (PNP/BFP/MDRRMO) and
  municipality instead of running `scripts/seed-dispatchers.js` by hand — and
  lists every account, split into two tabs: **Dispatcher & Admin Accounts**
  and **Citizen Accounts**.
- **Admin accounts are scoped to just Manage Accounts + Setting** — Dashboard,
  Manage Alerts, Manage Reports, and Analytics & Report are dispatcher-only.
  This is enforced two ways, not just by hiding sidebar links: `Sidebar.jsx`
  shows a different, shorter menu for `role = 'admin'`, and each dispatcher
  screen's route is wrapped in `DispatcherRoute` (`src/components/
  DispatcherRoute.jsx`), which bounces an admin straight to Manage Accounts
  if they try to reach one directly (e.g. a bookmarked `/reports` URL).

## Setting up account creation (Manage Accounts)

Creating a Supabase Auth user for someone else needs the **service_role**
key, which must never ship to the browser. So account creation runs through
a Supabase Edge Function (`supabase/functions/create-dispatcher`) instead of
directly from the React app — the browser calls the function, the function
holds the service_role key as a server-side secret.

1. Install the Supabase CLI, then from the `resq-dispatcher` folder:
   ```bash
   supabase login
   supabase link --project-ref <your-project-ref>
   supabase functions deploy create-dispatcher
   ```
2. That's it — `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and
   `SUPABASE_SERVICE_ROLE_KEY` are injected into every Edge Function
   automatically by Supabase, so there's nothing extra to set as a secret.
3. **Bootstrapping the first admin:** the Manage Accounts screen only shows
   up for an existing admin, so the very first admin account has to be
   promoted by hand, once, in the Supabase SQL editor:
   ```sql
   update public.profiles set role = 'admin' where email = 'you@example.com';
   ```
   Sign up that account from the citizen app (or `scripts/seed-dispatchers.js`)
   first if it doesn't exist yet. Every admin created after that can use the
   in-app form.

## Run it

```bash
npm install
cp .env.local.example .env.local   # fill in your Supabase project values
npm run dev                        # http://localhost:5174
```

## Status model

The citizen app writes `status: "pending"` on submit. This dashboard treats
that pipeline as: **Pending** → dispatcher clicks **Verify** → `acknowledged`
("Verified" in the UI, matches the Figma) → dispatcher clicks **Mark
Responded** → `resolved` ("Responded" in the UI). `verified_at` /
`responded_at` timestamps (added by the schema patch) let the trend charts
plot each stage over time, not just the initial report.

## Dispatcher response times & call history

**Analytics & Report** has two tabs: Overview (the original charts) and
**Dispatcher Response Times**. **Call History** and **Broadcast Alerts** are
their own pages in the sidebar, below Manage Reports.

Run `supabase/response_tracking_schema.sql` in the Supabase SQL editor (after
`dispatcher_schema.sql`) to turn it on. It:

- adds `first_viewed_by/at`, `verified_by`, `responded_by` to `incidents`, so
  each step of a report is tied to the dispatcher who did it;
- creates `call_logs` — one row per in-app call, both directions (a citizen
  calling for help, a dispatcher calling a citizen), with who, when it rang,
  when it was picked up, talk time, and the outcome (completed, missed, no
  answer, declined, failed);
- stamps `verified_at`, `responded_at`, `first_viewed_at` and the call times
  from the **database** clock, so response time (`responded_at - created_at`)
  is never skewed by a dispatcher PC's wrong clock.

Response time is always measured from the moment the citizen submitted the
report. Reports handled before the migration keep their timestamps but show
"Not recorded" for the dispatcher. Until the migration is run, the rest of the
console works as before and the new tab/page show a setup notice.

## Jurisdiction: which dispatchers get which emergency

Emergencies are routed by **where they happen**, not by the reporter's home
municipality. A San Jose resident who presses SOS while in Goa is a Goa
emergency: every Goa dispatcher (PNP, BFP and MDRRMO alike) receives it, and
San Jose dispatchers do not.

Run `supabase/jurisdiction_schema.sql` after `response_tracking_schema.sql`.
It:

- stores the official municipal boundaries for Goa, San Jose, Lagonoy, Tigaon
  and Sangay (PSA/PSGC data, simplified to ~16 m; plain Postgres polygons, no
  PostGIS needed);
- stamps `incidents.jurisdiction` from the report's GPS coordinates in the
  database, so it can't be set or changed by the client;
- replaces the "every dispatcher sees every report" policies with
  row-level security, so a dispatcher can only read or act on reports in the
  municipality on their account (reports, attached media and call history).
  Admins see everything.

What counts as "their municipality" is the **municipality on the dispatcher's
account** (set in Manage Accounts). A dispatcher account with no municipality
sees only unplaced reports.

Anything that can't be placed — outside the five municipalities (more than
~1.5 km beyond a border) or with no usable GPS — has `jurisdiction = null` and
goes to **every** dispatcher, so an emergency is never silently dropped.

Live citizen calls arrive over a shared broadcast channel rather than the
database, so each console asks the database (`jurisdiction_at(lat, lng)`) where
the caller is and only rings if it's in that dispatcher's jurisdiction. If that
lookup fails the console rings anyway: a missed emergency call is worse than an
extra ring.

Not covered by this migration: broadcast alerts posted from the Broadcast
Alerts page (these have their own municipality field), and dispatchers can
still read citizen *profiles* (name, phone) across municipalities.

## Notes / next steps

- The map centers on Goa, Camarines Sur by default; adjust
  `DEFAULT_CENTER` in `src/components/IncidentMap.jsx` if you want a
  different default view.
- Tile requests go to the public `tile.openstreetmap.org` — fine for
  development/demo/thesis-defense traffic; swap in a paid tile provider
  (MapTiler, Stadia, etc.) before any real production rollout, per OSM's
  usage policy.
- Incident media (photos/videos) is fetched via `incident_media(*)` in
  `getAllIncidents` but not yet surfaced in the UI — add a lightbox in
  `ManageReports`/`ManageAlerts` when you're ready.
