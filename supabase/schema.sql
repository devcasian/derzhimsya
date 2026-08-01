-- Держимся — database schema
-- Run this whole file in Supabase Dashboard → SQL Editor.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists participants (
  id                text primary key,
  name              text    not null,
  habit             text    not null,
  question          text    not null,
  telegram_chat_id  bigint  not null unique,
  start_date        date    not null,
  sort_order        int     not null default 0
);

create table if not exists checkins (
  participant_id  text        not null references participants(id) on delete cascade,
  date            date        not null,
  success         boolean     not null,
  created_at      timestamptz not null default now(),
  primary key (participant_id, date)
);

alter table participants enable row level security;
alter table checkins     enable row level security;

-- No policies at all: anon and authenticated roles cannot touch these tables
-- directly. The site reads through stats() only; the bot writes with the
-- service role key, which bypasses RLS.
--
-- The revoke is defence in depth: without it, adding a permissive policy later
-- would immediately expose telegram_chat_id to anyone with the public key.
revoke all on table participants from anon, authenticated;
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
      p.id as participant_id,
      gs::date as date,
      case
        when c.success is true  then 'success'
        when c.success is false then 'fail'
        when gs::date >= pr.today - pr.grace_days then 'pending'
        else 'missed'
      end as status
    from participants p
    cross join params pr
    cross join lateral generate_series(p.start_date::timestamp, pr.today::timestamp, interval '1 day') gs
    left join checkins c on c.participant_id = p.id and c.date = gs::date
  ),

  last_break as (
    select participant_id, max(date) as date
    from day_status
    where status in ('fail', 'missed')
    group by participant_id
  ),

  current_streaks as (
    select ds.participant_id, count(*) as streak
    from day_status ds
    left join last_break lb on lb.participant_id = ds.participant_id
    where ds.status = 'success'
      and (lb.date is null or ds.date > lb.date)
    group by ds.participant_id
  ),

  -- Running count of breaks splits the timeline into segments; the longest
  -- run of successes inside any segment is the best streak.
  segments as (
    select
      participant_id,
      status,
      sum(case when status in ('fail', 'missed') then 1 else 0 end)
        over (partition by participant_id order by date) as segment
    from day_status
  ),

  best_streaks as (
    select participant_id, max(cnt) as streak
    from (
      select participant_id, segment, count(*) filter (where status = 'success') as cnt
      from segments
      group by participant_id, segment
    ) s
    group by participant_id
  ),

  pair_days as (
    select
      date,
      case
        when bool_and(status = 'success')            then 'success'
        when bool_or(status in ('fail', 'missed'))   then 'fail'
        else 'pending'
      end as status
    from day_status
    group by date
    -- A day only counts as joint if every participant was already tracking it.
    having count(*) = (select count(*) from participants)
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

  'participants', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id',             p.id,
      'name',           p.name,
      'habit',          p.habit,
      'startDate',      p.start_date,
      'currentStreak',  coalesce(cs.streak, 0),
      'bestStreak',     coalesce(bs.streak, 0),
      'totalSuccess',   (select count(*) from day_status ds
                          where ds.participant_id = p.id and ds.status = 'success'),
      'totalFail',      (select count(*) from day_status ds
                          where ds.participant_id = p.id and ds.status in ('fail', 'missed')),
      'days',           (select jsonb_agg(jsonb_build_object('date', ds.date, 'status', ds.status)
                                          order by ds.date)
                          from day_status ds where ds.participant_id = p.id)
    ) order by p.sort_order, p.id)
    from participants p
    left join current_streaks cs on cs.participant_id = p.id
    left join best_streaks    bs on bs.participant_id = p.id
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

-- Participants live in seed.local.sql, which is git-ignored (it holds chat ids).
