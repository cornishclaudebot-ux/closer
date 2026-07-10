-- ============================================================================
-- Closer V2 — proximity engine schema  (Supabase / Postgres 15 + PostGIS)
-- Run in Supabase SQL Editor, or `supabase db push` once linked.
-- Enable first (Dashboard > Database > Extensions): postgis, pg_cron.
-- ============================================================================
create extension if not exists postgis;

-- ---------------------------------------------------------------- tuning knobs
-- Proximity radius: 50 m   | Time window: 5 min   | New-session gap: 30 min
-- Ping cadence (client): 60 s while on campus | Raw-ping retention: 2 h
-- Change the numbers in closer_detect_encounters() + the cron purge below.

-- ============================================================ PROFILES
create table if not exists public.profiles (
  id              uuid primary key references auth.users(id) on delete cascade,
  handle          text unique,
  display_name    text not null,
  age             int  check (age between 18 and 40),
  bio             text,
  gender          text,
  interested_in   text[] not null default '{}',
  photos          text[] not null default '{}',   -- Supabase Storage object paths
  gcu_verified    boolean not null default false,  -- set true after .edu confirm
  is_discoverable boolean not null default true,
  last_seen       timestamptz,
  created_at      timestamptz not null default now()
);

-- ============================================================ LOCATION PINGS (ephemeral)
-- Raw traces. Short-lived by design; clients can only ever read their OWN.
create table if not exists public.location_pings (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  geog        geography(Point,4326) not null,
  accuracy_m  real,
  captured_at timestamptz not null default now()
);
create index if not exists location_pings_geog_idx      on public.location_pings using gist (geog);
create index if not exists location_pings_time_idx      on public.location_pings (captured_at);
create index if not exists location_pings_user_time_idx on public.location_pings (user_id, captured_at desc);

-- ============================================================ CAMPUS PLACES (POIs -> labels)
create table if not exists public.campus_places (
  id       serial primary key,
  name     text not null,
  geog     geography(Point,4326) not null,
  radius_m int  not null default 60
);
create index if not exists campus_places_geog_idx on public.campus_places using gist (geog);

-- ============================================================ ENCOUNTERS (derived "crossed paths")
-- One row per unordered pair (user_a < user_b). The value the app keeps.
create table if not exists public.encounters (
  id              bigint generated always as identity primary key,
  user_a          uuid not null references auth.users(id) on delete cascade,
  user_b          uuid not null references auth.users(id) on delete cascade,
  first_at        timestamptz not null default now(),
  last_at         timestamptz not null default now(),
  encounter_count int  not null default 1,          -- distinct sessions (">30 min apart")
  last_place      text,
  min_distance_m  real,
  created_at      timestamptz not null default now(),
  constraint encounters_pair_ordered check (user_a < user_b),
  constraint encounters_pair_unique  unique (user_a, user_b)
);
create index if not exists encounters_user_a_idx on public.encounters (user_a, last_at desc);
create index if not exists encounters_user_b_idx on public.encounters (user_b, last_at desc);

-- ============================================================ LIKES / MATCHES / MESSAGES
create table if not exists public.likes (
  id      bigint generated always as identity primary key,
  liker   uuid not null references auth.users(id) on delete cascade,
  likee   uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (liker, likee),
  check (liker <> likee)
);

create table if not exists public.matches (
  id           bigint generated always as identity primary key,
  user_a       uuid not null references auth.users(id) on delete cascade,
  user_b       uuid not null references auth.users(id) on delete cascade,
  encounter_id bigint references public.encounters(id) on delete set null,
  created_at   timestamptz not null default now(),
  constraint matches_pair_ordered check (user_a < user_b),
  constraint matches_pair_unique  unique (user_a, user_b)
);

create table if not exists public.messages (
  id         bigint generated always as identity primary key,
  match_id   bigint not null references public.matches(id) on delete cascade,
  sender_id  uuid   not null references auth.users(id) on delete cascade,
  body       text   not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index if not exists messages_match_idx on public.messages (match_id, created_at);

-- ============================================================ SAFETY
create table if not exists public.blocks (
  blocker uuid not null references auth.users(id) on delete cascade,
  blocked uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker, blocked)
);
create table if not exists public.reports (
  id        bigint generated always as identity primary key,
  reporter  uuid not null references auth.users(id) on delete cascade,
  reported  uuid not null references auth.users(id) on delete cascade,
  reason    text,
  created_at timestamptz not null default now()
);

-- ============================================================ THE PROXIMITY ENGINE
-- nearest labeled place for a point, else null
create or replace function public.closer_nearest_place(p geography)
returns text language sql stable set search_path = public as $$
  select name from public.campus_places
  where st_dwithin(geog, p, radius_m)
  order by st_distance(geog, p) limit 1;
$$;

-- Given one new ping, find who this user crossed paths with and upsert encounters.
-- SECURITY DEFINER: reads all pings to compute proximity, but clients never can.
create or replace function public.closer_detect_encounters(
  p_user uuid, p_geog geography, p_at timestamptz)
returns void language plpgsql security definer set search_path = public as $$
declare r record; a uuid; b uuid; place text;
begin
  place := public.closer_nearest_place(p_geog);
  for r in
    select lp.user_id as other, min(st_distance(lp.geog, p_geog)) as dist
    from public.location_pings lp
    join public.profiles pr on pr.id = lp.user_id
    where lp.user_id <> p_user
      and lp.captured_at > p_at - interval '5 minutes'   -- TIME WINDOW
      and st_dwithin(lp.geog, p_geog, 50)                -- PROXIMITY RADIUS (m)
      and pr.is_discoverable
      and not exists (select 1 from public.blocks bl
            where (bl.blocker = p_user  and bl.blocked = lp.user_id)
               or (bl.blocker = lp.user_id and bl.blocked = p_user))
    group by lp.user_id
  loop
    a := least(p_user, r.other); b := greatest(p_user, r.other);
    insert into public.encounters as e
        (user_a, user_b, first_at, last_at, encounter_count, last_place, min_distance_m)
      values (a, b, p_at, p_at, 1, place, r.dist)
    on conflict (user_a, user_b) do update set
      last_at        = greatest(e.last_at, excluded.last_at),
      last_place     = excluded.last_place,
      min_distance_m = least(coalesce(e.min_distance_m, excluded.min_distance_m), excluded.min_distance_m),
      encounter_count = e.encounter_count
        + case when excluded.last_at - e.last_at > interval '30 minutes' then 1 else 0 end;  -- NEW-SESSION GAP
  end loop;
end;
$$;

-- Fire detection on every ping (MVP). At scale, drop this trigger and run
-- closer_detect_encounters over new pings from a pg_cron batch every 1-2 min.
create or replace function public.closer_on_ping()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.profiles set last_seen = new.captured_at where id = new.user_id;
  perform public.closer_detect_encounters(new.user_id, new.geog, new.captured_at);
  return new;
end;
$$;
drop trigger if exists trg_closer_on_ping on public.location_pings;
create trigger trg_closer_on_ping after insert on public.location_pings
  for each row execute function public.closer_on_ping();

-- Mutual like -> match (linked to the encounter that connected them)
create or replace function public.closer_on_like()
returns trigger language plpgsql security definer set search_path = public as $$
declare a uuid; b uuid; enc bigint;
begin
  if exists (select 1 from public.likes l where l.liker = new.likee and l.likee = new.liker) then
    a := least(new.liker, new.likee); b := greatest(new.liker, new.likee);
    select id into enc from public.encounters where user_a = a and user_b = b;
    insert into public.matches (user_a, user_b, encounter_id) values (a, b, enc)
      on conflict (user_a, user_b) do nothing;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_closer_on_like on public.likes;
create trigger trg_closer_on_like after insert on public.likes
  for each row execute function public.closer_on_like();

-- The Discover feed: who you crossed paths with, not yet liked, not blocked.
create or replace function public.get_crossed_paths()
returns table (other_id uuid, display_name text, age int, photos text[],
               encounter_count int, last_at timestamptz, last_place text)
language sql stable security invoker set search_path = public as $$
  select pr.id, pr.display_name, pr.age, pr.photos,
         e.encounter_count, e.last_at, e.last_place
  from public.encounters e
  join public.profiles pr
    on pr.id = case when e.user_a = auth.uid() then e.user_b else e.user_a end
  where auth.uid() in (e.user_a, e.user_b)
    and pr.is_discoverable
    and not exists (select 1 from public.likes l where l.liker = auth.uid() and l.likee = pr.id)
    and not exists (select 1 from public.blocks b
          where (b.blocker = auth.uid() and b.blocked = pr.id)
             or (b.blocker = pr.id and b.blocked = auth.uid()))
  order by e.encounter_count desc, e.last_at desc
  limit 50;
$$;

-- ============================================================ PRIVACY: purge raw traces
-- Keep encounters forever, raw locations for 2h. Needs pg_cron enabled.
select cron.schedule('closer-purge-pings', '*/15 * * * *',
  $$ delete from public.location_pings where captured_at < now() - interval '2 hours' $$);

-- ============================================================ ROW LEVEL SECURITY
alter table public.profiles      enable row level security;
alter table public.location_pings enable row level security;
alter table public.encounters    enable row level security;
alter table public.likes         enable row level security;
alter table public.matches       enable row level security;
alter table public.messages      enable row level security;
alter table public.blocks        enable row level security;
alter table public.reports       enable row level security;
alter table public.campus_places enable row level security;

drop policy if exists profiles_read        on public.profiles;
drop policy if exists profiles_insert_self  on public.profiles;
drop policy if exists profiles_update_self  on public.profiles;
create policy profiles_read        on public.profiles for select to authenticated using (is_discoverable or id = auth.uid());
create policy profiles_insert_self on public.profiles for insert to authenticated with check (id = auth.uid());
create policy profiles_update_self on public.profiles for update to authenticated using (id = auth.uid());

drop policy if exists pings_own on public.location_pings;
create policy pings_own on public.location_pings for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());   -- never read others' raw traces

drop policy if exists enc_read on public.encounters;
create policy enc_read on public.encounters for select to authenticated
  using (auth.uid() in (user_a, user_b));   -- writes only via SECURITY DEFINER fn

drop policy if exists likes_own on public.likes;
create policy likes_own on public.likes for all to authenticated
  using (liker = auth.uid()) with check (liker = auth.uid());

drop policy if exists matches_read on public.matches;
create policy matches_read on public.matches for select to authenticated
  using (auth.uid() in (user_a, user_b));

drop policy if exists messages_read on public.messages;
drop policy if exists messages_send on public.messages;
create policy messages_read on public.messages for select to authenticated
  using (exists (select 1 from public.matches m where m.id = match_id and auth.uid() in (m.user_a, m.user_b)));
create policy messages_send on public.messages for insert to authenticated
  with check (sender_id = auth.uid()
    and exists (select 1 from public.matches m where m.id = match_id and auth.uid() in (m.user_a, m.user_b)));

drop policy if exists blocks_own  on public.blocks;
drop policy if exists reports_own on public.reports;
drop policy if exists places_read on public.campus_places;
create policy blocks_own  on public.blocks  for all    to authenticated using (blocker = auth.uid())  with check (blocker = auth.uid());
create policy reports_own on public.reports for all    to authenticated using (reporter = auth.uid()) with check (reporter = auth.uid());
create policy places_read on public.campus_places for select to authenticated using (true);

-- Realtime: broadcast matches + messages so the app reacts live.
alter publication supabase_realtime add table public.matches;
alter publication supabase_realtime add table public.messages;
