-- Community curb submissions, with an append-only audit log.
-- Run once in the Supabase SQL editor (or `supabase db push`). Every table has row-level security on and no
-- policies: the browser never talks to the database. Only the API functions (api/*.js, secret key) read and write.

create extension if not exists pgcrypto;

-- A proposed set of rules for a curb (or a stretch of it), or a plain "looks right" confirmation.
create table if not exists public.submissions (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  kind          text not null check (kind in ('correction', 'confirm')),
  curb_zone_id  text not null,                 -- the city's curb id (stable across our builds)
  stretch_from  real,                          -- meters along the city's curb line; null = the whole curb
  stretch_to    real,
  curb_length   real,                          -- the curb's length when submitted (to spot city redraws)
  curb_lng      double precision,              -- where on the map the curb was tapped (for the reviewer)
  curb_lat      double precision,
  rules         jsonb,                         -- proposed rules, CDS-style policies (corrections only)
  based_on      text,                          -- the rule ids the submitter was looking at
  data_version  text,                          -- the map build they were looking at
  note          text check (char_length(note) <= 1000),
  photo_path    text,                          -- evidence in the private "evidence" bucket
  lat           double precision,              -- submitter location, if they shared it
  lng           double precision,
  accuracy_m    real,
  device_id     text not null,                 -- random id kept in the browser (no accounts yet)
  ip_hash       text,                          -- salted hash, for rate limits and abuse review only
  status        text not null default 'pending' check (status in ('pending', 'accepted', 'rejected', 'superseded')),
  reviewed_at   timestamptz,
  reviewer      text,
  review_note   text check (char_length(review_note) <= 1000),
  check (stretch_from is null or (stretch_to is not null and stretch_from >= 0 and stretch_to > stretch_from)),
  check (kind <> 'correction' or rules is not null)
);
create index if not exists submissions_curb on public.submissions (curb_zone_id, status);
create index if not exists submissions_status on public.submissions (status, created_at);
create index if not exists submissions_device on public.submissions (device_id, created_at);

-- "Matches what I see" on someone else's pending correction. One per device per submission.
create table if not exists public.confirmations (
  id             bigserial primary key,
  created_at     timestamptz not null default now(),
  submission_id  uuid not null references public.submissions (id),
  device_id      text not null,
  ip_hash        text,
  unique (submission_id, device_id)
);

-- Everything that happens, in order. Rows can be added, never changed or removed: undoing something is a new event.
create table if not exists public.events (
  id             bigserial primary key,
  at             timestamptz not null default now(),
  actor          text not null,                -- 'device:<id>' or 'reviewer:<name>'
  action         text not null,                -- submitted | confirmed | accepted | rejected | superseded | reverted
  submission_id  uuid references public.submissions (id),
  curb_zone_id   text,
  detail         jsonb
);
create index if not exists events_curb on public.events (curb_zone_id, at);

create or replace function public.events_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'events are append-only';
end $$;
drop trigger if exists events_append_only on public.events;
create trigger events_append_only before update or delete on public.events
  for each row execute function public.events_append_only();

alter table public.submissions enable row level security;
alter table public.confirmations enable row level security;
alter table public.events enable row level security;
