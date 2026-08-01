-- derzhimsya — database schema
-- Run this whole file in Supabase Dashboard → SQL Editor.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ---------------------------------------------------------------------------
-- Tables
--
-- A habit belongs to a participant, and a participant can have several. Shared
-- habits are the ones the joint streak is built from; personal ones (Vlad's
-- vape) are tracked the same way but never drag the pair down.
-- ---------------------------------------------------------------------------

drop table if exists checkins cascade;
drop table if exists habits cascade;
drop table if exists participants cascade;

create table participants (
  id                text   primary key,
  name              text   not null,
  telegram_chat_id  bigint not null unique,
  sort_order        int    not null default 0
);

create table habits (
  id              text    primary key,
  participant_id  text    not null references participants(id) on delete cascade,
  title           text    not null,
  question        text    not null,
  is_shared       boolean not null default false,
  start_date      date    not null,
  sort_order      int     not null default 0
);

create table checkins (
  habit_id    text        not null references habits(id) on delete cascade,
  date        date        not null,
  success     boolean     not null,
  created_at  timestamptz not null default now(),
  primary key (habit_id, date)
);

create index on habits (participant_id);

alter table participants enable row level security;
alter table habits       enable row level security;
alter table checkins     enable row level security;

-- No policies at all: anon and authenticated roles cannot touch these tables
-- directly. The site reads through stats() only; the bot writes with the
-- service role key, which bypasses RLS.
--
-- The revoke is defence in depth: without it, adding a permissive policy later
-- would immediately expose telegram_chat_id to anyone with the public key.
revoke all on table participants from anon, authenticated;
revoke all on table habits       from anon, authenticated;
revoke all on table checkins     from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function moscow_today() returns date
language sql stable as $$
  select (now() at time zone 'Europe/Moscow')::date;
$$;

-- ---------------------------------------------------------------------------
-- stats() — single source of truth for both the site and the bot.
--
-- Day status:
--   success  — checked in, held out
--   fail     — checked in, broke the habit
--   pending  — not checked in yet, still within the grace window
--   missed   — not checked in, grace window expired → counts as a break
-- ---------------------------------------------------------------------------

create or replace function stats() returns jsonb
language sql stable security definer set search_path = public as $$
with
  params as (select moscow_today() as today, 2 as grace_days),

  day_status as (
    select
      h.id as habit_id,
      gs::date as date,
      case
        when c.success is true  then 'success'
        when c.success is false then 'fail'
        when gs::date >= pr.today - pr.grace_days then 'pending'
        else 'missed'
      end as status
    from habits h
    cross join params pr
    cross join lateral generate_series(h.start_date::timestamp, pr.today::timestamp, interval '1 day') gs
    left join checkins c on c.habit_id = h.id and c.date = gs::date
  ),

  last_break as (
    select habit_id, max(date) as date
    from day_status
    where status in ('fail', 'missed')
    group by habit_id
  ),

  current_streaks as (
    select ds.habit_id, count(*) as streak
    from day_status ds
    left join last_break lb on lb.habit_id = ds.habit_id
    where ds.status = 'success'
      and (lb.date is null or ds.date > lb.date)
    group by ds.habit_id
  ),

  -- Running count of breaks splits the timeline into segments; the longest
  -- run of successes inside any segment is the best streak.
  segments as (
    select
      habit_id,
      status,
      sum(case when status in ('fail', 'missed') then 1 else 0 end)
        over (partition by habit_id order by date) as segment
    from day_status
  ),

  best_streaks as (
    select habit_id, max(cnt) as streak
    from (
      select habit_id, segment, count(*) filter (where status = 'success') as cnt
      from segments
      group by habit_id, segment
    ) s
    group by habit_id
  ),

  shared_status as (
    select ds.* from day_status ds
    join habits h on h.id = ds.habit_id
    where h.is_shared
  ),

  pair_days as (
    select
      date,
      case
        when bool_and(status = 'success')          then 'success'
        when bool_or(status in ('fail', 'missed')) then 'fail'
        else 'pending'
      end as status
    from shared_status
    group by date
    -- A day only counts as joint if every shared habit was already running.
    having count(*) = (select count(*) from habits where is_shared)
  ),

  pair_last_break as (select max(date) as date from pair_days where status = 'fail'),

  pair_segments as (
    select
      date, status,
      sum(case when status = 'fail' then 1 else 0 end) over (order by date) as segment
    from pair_days
  )

select jsonb_build_object(
  'today',      (select today from params),
  'graceDays',  (select grace_days from params),

  'habits', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id',              h.id,
      'participantId',   p.id,
      'participantName', p.name,
      'title',           h.title,
      'isShared',        h.is_shared,
      'startDate',       h.start_date,
      'currentStreak',   coalesce(cs.streak, 0),
      'bestStreak',      coalesce(bs.streak, 0),
      'totalSuccess',    (select count(*) from day_status ds
                           where ds.habit_id = h.id and ds.status = 'success'),
      'totalFail',       (select count(*) from day_status ds
                           where ds.habit_id = h.id and ds.status in ('fail', 'missed')),
      -- Empty until the start date arrives, so coalesce keeps it an array.
      'days',            coalesce((select jsonb_agg(jsonb_build_object('date', ds.date, 'status', ds.status)
                                                    order by ds.date)
                                    from day_status ds where ds.habit_id = h.id), '[]'::jsonb)
    ) order by p.sort_order, h.sort_order, h.id)
    from habits h
    join participants p on p.id = h.participant_id
    left join current_streaks cs on cs.habit_id = h.id
    left join best_streaks    bs on bs.habit_id = h.id
  ), '[]'::jsonb),

  'pair', jsonb_build_object(
    'currentStreak', (
      select count(*) from pair_days pd
      where pd.status = 'success'
        and ((select date from pair_last_break) is null or pd.date > (select date from pair_last_break))
    ),
    'bestStreak', coalesce((
      select max(cnt) from (
        select segment, count(*) filter (where status = 'success') as cnt
        from pair_segments group by segment
      ) s
    ), 0),
    'totalDays', (select count(*) from pair_days where status = 'success'),
    'days', coalesce((
      select jsonb_agg(jsonb_build_object('date', date, 'status', status) order by date)
      from pair_days
    ), '[]'::jsonb)
  )
);
$$;

revoke all on function stats() from public;
grant execute on function stats() to anon, authenticated;

-- Participants and habits live in seed.local.sql, which is git-ignored
-- (it holds chat ids).
