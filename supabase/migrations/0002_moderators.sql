-- Who may review community corrections. Signing in (Google, Apple or email) only proves who someone is; being in
-- this table is what makes them a moderator. Add people with `npm run add-moderator -- someone@example.com`.
-- Row-level security on, no policies: only the API functions (secret key) read it.
create table if not exists public.moderators (
  user_id   uuid primary key references auth.users (id) on delete cascade,
  email     text,
  added_at  timestamptz not null default now(),
  added_by  text
);
alter table public.moderators enable row level security;
