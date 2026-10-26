-- ResQPartido — dispatcher response tracking + call history
-- Run this in the Supabase SQL editor AFTER dispatcher_schema.sql (it needs
-- public.is_dispatcher() and the verified_at / responded_at columns that
-- migration adds). Safe to re-run.
--
-- It adds two things the Analytics & Report page needs:
--
--   1. WHO acted on each report. The app already stored WHEN a report was
--      verified / responded (verified_at, responded_at) but not which
--      dispatcher did it, so per-dispatcher response times were impossible.
--
--   2. A persistent call history. Calls are WebRTC over Supabase Realtime
--      broadcast, which leaves no trace once the call ends. call_logs keeps
--      one row per call, in both directions:
--        outbound = a dispatcher called a citizen (from a report)
--        inbound  = a citizen called in for help (any dispatcher can answer)

-- ---------------------------------------------------------------
-- 1. Who viewed / verified / responded to each incident.
--    Reports handled before this migration keep their timestamps but have
--    no dispatcher recorded — the analytics page labels those "Not recorded".
-- ---------------------------------------------------------------
alter table public.incidents
  add column if not exists first_viewed_at timestamptz,
  add column if not exists first_viewed_by uuid references public.profiles(id) on delete set null,
  add column if not exists verified_by uuid references public.profiles(id) on delete set null,
  add column if not exists responded_by uuid references public.profiles(id) on delete set null;

-- Response time = (verified_at / responded_at) - created_at. created_at comes
-- from the database clock, while the dispatcher console used to stamp
-- verified_at / responded_at from the dispatcher's own computer — a PC whose
-- clock is a few minutes off would produce wrong (even negative) response
-- times. This trigger overwrites those stamps with the database clock at the
-- moment the status really changes, so every number is measured on one clock.
create or replace function public.stamp_incident_times()
returns trigger
language plpgsql
as $$
begin
  if new.status is distinct from old.status then
    if new.status = 'acknowledged' then new.verified_at := now(); end if;
    if new.status = 'resolved' then new.responded_at := now(); end if;
  end if;
  if old.first_viewed_at is null and new.first_viewed_at is not null then
    new.first_viewed_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists stamp_incident_times on public.incidents;
create trigger stamp_incident_times
  before update on public.incidents
  for each row execute function public.stamp_incident_times();

-- ---------------------------------------------------------------
-- 2. call_logs
--    incident_id has to match the type of incidents.id exactly, and that
--    schema lives in the citizen app's schema.sql, so the type is looked up
--    here instead of assumed.
-- ---------------------------------------------------------------
do $$
declare
  incident_id_type text;
begin
  select format_type(a.atttypid, a.atttypmod)
    into incident_id_type
    from pg_attribute a
   where a.attrelid = 'public.incidents'::regclass
     and a.attname = 'id'
     and not a.attisdropped;

  execute format($sql$
    create table if not exists public.call_logs (
      id uuid primary key default gen_random_uuid(),

      -- inbound calls: the citizen app's callId, so every dispatcher console
      -- that hears the same ring writes to ONE row. Null for outbound calls.
      call_ref text unique,

      direction text not null check (direction in ('inbound', 'outbound')),

      dispatcher_id uuid references public.profiles(id) on delete set null,
      citizen_id uuid references public.profiles(id) on delete set null,
      -- Name snapshots so the history still reads correctly if a citizen
      -- deletes their account (citizen_id becomes null) or a name changes.
      dispatcher_name text,
      citizen_name text,

      incident_id %s references public.incidents(id) on delete set null,
      incident_type text,
      municipality text,

      started_at timestamptz not null default now(),  -- call placed / started ringing
      answered_at timestamptz,                        -- picked up (by the citizen for outbound, by the dispatcher for inbound)
      ended_at timestamptz,
      duration_seconds integer,                       -- talk time: audio connected -> hang up

      outcome text not null default 'ringing' check (
        outcome in ('ringing', 'connected', 'completed', 'missed', 'no_answer', 'declined', 'failed')
      )
    )
  $sql$, incident_id_type);
end $$;

create index if not exists call_logs_started_at_idx on public.call_logs (started_at desc);
create index if not exists call_logs_dispatcher_idx on public.call_logs (dispatcher_id);
create index if not exists call_logs_citizen_idx on public.call_logs (citizen_id);
create index if not exists call_logs_incident_idx on public.call_logs (incident_id);

-- Same reasoning as above: call start / pickup / hang-up times are all taken
-- from the database clock so "how long did the citizen wait" is exact.
create or replace function public.stamp_call_log_times()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    new.started_at := now();
  end if;
  if new.answered_at is not null and (tg_op = 'INSERT' or old.answered_at is null) then
    new.answered_at := now();
  end if;
  if new.ended_at is not null and (tg_op = 'INSERT' or old.ended_at is null) then
    new.ended_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists stamp_call_log_times on public.call_logs;
create trigger stamp_call_log_times
  before insert or update on public.call_logs
  for each row execute function public.stamp_call_log_times();

alter table public.call_logs enable row level security;

drop policy if exists "call_logs: dispatcher read all" on public.call_logs;
create policy "call_logs: dispatcher read all" on public.call_logs
  for select using (public.is_dispatcher());

drop policy if exists "call_logs: dispatcher insert" on public.call_logs;
create policy "call_logs: dispatcher insert" on public.call_logs
  for insert with check (public.is_dispatcher());

drop policy if exists "call_logs: dispatcher update" on public.call_logs;
create policy "call_logs: dispatcher update" on public.call_logs
  for update using (public.is_dispatcher()) with check (public.is_dispatcher());

-- A citizen can read their own call history (for a "My calls" screen in the
-- citizen app). Read-only — only dispatcher consoles write call logs.
drop policy if exists "call_logs: citizen read own" on public.call_logs;
create policy "call_logs: citizen read own" on public.call_logs
  for select using (citizen_id = auth.uid());

-- Live updates on the Analytics page's Call History tab.
do $$
begin
  alter publication supabase_realtime add table public.call_logs;
exception
  when duplicate_object then null;
end $$;
