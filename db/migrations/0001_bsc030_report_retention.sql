-- BSC-030 (DEC-020): keep each paid Lost Booking Diagnostic's inputs + report for >= 90 days.
--
-- NOT APPLIED. Founder must choose the Supabase project and approve before this runs.
-- Creates two NEW tables. It does not read, alter or drop any existing table
-- (including any pre-existing `diagnostic_runs`, whose schema could not be inspected).
--
-- Access model
--   * One row per purchase (unique license_hash). The raw license key is never stored:
--     license_hash = sha256('lbd:v1:' || license_key), computed server-side.
--   * RLS on, zero policies, table + function privileges revoked from anon/authenticated.
--     Only the server (service_role key, held in Vercel env) can reach anything.
--   * Every state change and every read goes through one of the lbd_* functions below,
--     and each function writes its audit event IN THE SAME TRANSACTION as the change.
--     A save, retrieval or deletion therefore cannot happen without its log row.

create table if not exists public.diagnostic_reports (
  id                  uuid primary key default gen_random_uuid(),
  license_hash        text not null unique check (license_hash ~ '^[0-9a-f]{64}$'),
  gumroad_product_id  text not null,
  gumroad_sale_id     text,
  status              text not null check (status in ('pending','complete','failed','failed_final','deleted')),
  attempts            int  not null default 1 check (attempts between 1 and 10),
  max_attempts        int  not null default 3 check (max_attempts between 1 and 10),
  inputs              jsonb,
  report              jsonb,
  failure_reason      text,
  created_at          timestamptz not null default now(),
  attempt_started_at  timestamptz not null default now(),
  completed_at        timestamptz,
  retain_until        timestamptz not null,
  deleted_at          timestamptz,

  -- Requirement 6: every record carries its own retention, never shorter than 90 days.
  constraint retention_min_90_days   check (retain_until >= created_at + interval '90 days'),
  -- Requirement 4: a finished report always has its inputs beside it, in the same row.
  constraint complete_has_both       check (status <> 'complete' or (inputs is not null and report is not null and completed_at is not null)),
  constraint report_only_if_complete check (report is null or status = 'complete'),
  constraint live_row_has_inputs     check (status = 'deleted' or inputs is not null),
  constraint deleted_is_scrubbed     check (status <> 'deleted' or (inputs is null and report is null and deleted_at is not null)),
  -- Requirement 1: one fixed input format and one stored report format.
  constraint inputs_format           check (inputs is null or inputs->>'format' = 'lbd.inputs.v1'),
  constraint report_format           check (report is null or report->>'format' = 'lbd.report.v1')
);

create index if not exists diagnostic_reports_retain_idx
  on public.diagnostic_reports (retain_until) where status <> 'deleted';

-- Requirement 7: append-only audit trail. Never holds inputs or report content.
create table if not exists public.diagnostic_report_events (
  id           bigint generated always as identity primary key,
  report_id    uuid references public.diagnostic_reports(id),
  license_hash text,
  event        text not null check (event in ('claim','save','fail','retrieve','delete','extend','purge')),
  outcome      text not null,
  actor        text not null check (actor in ('buyer','admin','system')),
  detail       jsonb not null default '{}'::jsonb,
  at           timestamptz not null default now()
);
create index if not exists diagnostic_report_events_report_idx on public.diagnostic_report_events (report_id, at);

create or replace function public.lbd_events_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'diagnostic_report_events is append-only';
end $$;

drop trigger if exists lbd_events_no_change on public.diagnostic_report_events;
create trigger lbd_events_no_change before update or delete on public.diagnostic_report_events
  for each row execute function public.lbd_events_append_only();

alter table public.diagnostic_reports       enable row level security;
alter table public.diagnostic_report_events enable row level security;
revoke all on public.diagnostic_reports, public.diagnostic_report_events from public, anon, authenticated;

/* ------------------------------------------------------------------ helpers */

create or replace function public.lbd_log(p_report_id uuid, p_license_hash text, p_event text,
                                          p_outcome text, p_actor text, p_detail jsonb default '{}'::jsonb)
returns void language sql set search_path = public as $$
  insert into diagnostic_report_events (report_id, license_hash, event, outcome, actor, detail)
  values (p_report_id, p_license_hash, p_event, p_outcome, p_actor, coalesce(p_detail, '{}'::jsonb));
$$;

/* ------------------------------------------------------------------ claim
   Called before any model spend. Decides, atomically, whether this purchase may
   generate now. Decisions:
     generate     -> caller generates, then calls lbd_complete or lbd_fail with (report_id, attempt)
     replay       -> a finished report exists; return it unchanged (requirement 3)
     in_progress  -> another attempt started < p_stale_seconds ago
     exhausted    -> attempts used up; final state failed_final (requirement 5)
     deleted      -> record was deleted / purged
     expired      -> retention passed but purge has not run yet                        */
create or replace function public.lbd_claim(
  p_license_hash text, p_product_id text, p_sale_id text, p_inputs jsonb,
  p_retention_days int, p_stale_seconds int, p_max_attempts int)
returns jsonb language plpgsql set search_path = public as $$
declare
  r diagnostic_reports;
  v_days int := greatest(coalesce(p_retention_days, 90), 90);
begin
  if p_inputs is null or p_inputs->>'format' is distinct from 'lbd.inputs.v1' then
    raise exception 'lbd_claim: inputs must use format lbd.inputs.v1';
  end if;

  insert into diagnostic_reports (license_hash, gumroad_product_id, gumroad_sale_id, status,
                                  attempts, max_attempts, inputs, retain_until)
  values (p_license_hash, p_product_id, p_sale_id, 'pending', 1,
          least(greatest(coalesce(p_max_attempts, 3), 1), 10), p_inputs,
          now() + make_interval(days => v_days))
  on conflict (license_hash) do nothing
  returning * into r;

  if found then
    perform lbd_log(r.id, r.license_hash, 'claim', 'generate', 'buyer', jsonb_build_object('attempt', 1));
    return jsonb_build_object('decision','generate','report_id',r.id,'attempt',1,
                              'max_attempts',r.max_attempts,'retain_until',r.retain_until);
  end if;

  select * into r from diagnostic_reports where license_hash = p_license_hash for update;

  if r.status = 'complete' then
    if r.retain_until < now() then
      perform lbd_log(r.id, r.license_hash, 'claim', 'expired', 'buyer');
      return jsonb_build_object('decision','expired');
    end if;
    perform lbd_log(r.id, r.license_hash, 'claim', 'replay', 'buyer');
    return jsonb_build_object('decision','replay','report_id',r.id,'inputs',r.inputs,
                              'report',r.report,'retain_until',r.retain_until);
  elsif r.status = 'deleted' then
    perform lbd_log(r.id, r.license_hash, 'claim', 'deleted', 'buyer');
    return jsonb_build_object('decision','deleted');
  elsif r.status = 'failed_final' then
    perform lbd_log(r.id, r.license_hash, 'claim', 'exhausted', 'buyer');
    return jsonb_build_object('decision','exhausted','attempts',r.attempts);
  elsif r.status = 'pending'
        and r.attempt_started_at > now() - make_interval(secs => greatest(coalesce(p_stale_seconds,300),60)) then
    perform lbd_log(r.id, r.license_hash, 'claim', 'in_progress', 'buyer');
    return jsonb_build_object('decision','in_progress');
  end if;

  -- status is 'failed', or 'pending' but stale (the earlier attempt crashed or timed out).
  if r.status = 'pending' then
    perform lbd_log(r.id, r.license_hash, 'fail', 'stale_attempt_abandoned', 'system',
                    jsonb_build_object('attempt', r.attempts));
  end if;

  if r.attempts >= r.max_attempts then
    update diagnostic_reports
       set status = 'failed_final',
           failure_reason = coalesce(case when r.status = 'pending' then 'attempt_abandoned' end, failure_reason, 'attempts_exhausted')
     where id = r.id;
    perform lbd_log(r.id, r.license_hash, 'claim', 'exhausted', 'buyer', jsonb_build_object('attempts', r.attempts));
    return jsonb_build_object('decision','exhausted','attempts',r.attempts);
  end if;

  update diagnostic_reports
     set status = 'pending', attempts = attempts + 1, inputs = p_inputs, failure_reason = null,
         attempt_started_at = now(), gumroad_sale_id = coalesce(p_sale_id, gumroad_sale_id)
   where id = r.id
  returning * into r;
  perform lbd_log(r.id, r.license_hash, 'claim', 'generate', 'buyer', jsonb_build_object('attempt', r.attempts));
  return jsonb_build_object('decision','generate','report_id',r.id,'attempt',r.attempts,
                            'max_attempts',r.max_attempts,'retain_until',r.retain_until);
end $$;

/* ------------------------------------------------------------------ complete (save)
   Stores the report in the same row as the inputs that produced it. Only the attempt
   that holds the claim may write. Returns the stored inputs + report. Idempotent: re-sending the identical report for the
   same attempt (a retry after a lost response) succeeds without a second write.        */
create or replace function public.lbd_complete(p_report_id uuid, p_attempt int, p_report jsonb)
returns jsonb language plpgsql set search_path = public as $$
declare r diagnostic_reports;
begin
  if p_report is null or p_report->>'format' is distinct from 'lbd.report.v1' then
    raise exception 'lbd_complete: report must use format lbd.report.v1';
  end if;
  select * into r from diagnostic_reports where id = p_report_id for update;
  if not found then
    perform lbd_log(null, null, 'save', 'rejected_unknown_record', 'system', jsonb_build_object('report_id', p_report_id));
    return jsonb_build_object('ok', false, 'reason', 'unknown_record');
  end if;
  if r.status = 'complete' and r.attempts = p_attempt and r.report = p_report then
    perform lbd_log(r.id, r.license_hash, 'save', 'already_stored', 'system', jsonb_build_object('attempt', p_attempt));
    return jsonb_build_object('ok', true, 'retain_until', r.retain_until, 'idempotent', true,
                              'inputs', r.inputs, 'report', r.report);
  end if;
  if r.status <> 'pending' or r.attempts <> p_attempt then
    perform lbd_log(r.id, r.license_hash, 'save', 'rejected_stale_attempt', 'system',
                    jsonb_build_object('attempt', p_attempt, 'status', r.status, 'current_attempt', r.attempts));
    return jsonb_build_object('ok', false, 'reason', 'stale_attempt', 'status', r.status);
  end if;
  update diagnostic_reports set status = 'complete', report = p_report, completed_at = now()
   where id = r.id returning * into r;
  perform lbd_log(r.id, r.license_hash, 'save', 'stored', 'system', jsonb_build_object('attempt', p_attempt));
  -- Return the record exactly as stored, so the first response is built from the same
  -- bytes every later retrieval will read (jsonb normalises key order on write).
  return jsonb_build_object('ok', true, 'retain_until', r.retain_until, 'inputs', r.inputs, 'report', r.report);
end $$;

/* ------------------------------------------------------------------ fail */
create or replace function public.lbd_fail(p_report_id uuid, p_attempt int, p_reason text)
returns jsonb language plpgsql set search_path = public as $$
declare r diagnostic_reports; v_status text;
begin
  select * into r from diagnostic_reports where id = p_report_id for update;
  if not found or r.status <> 'pending' or r.attempts <> p_attempt then
    return jsonb_build_object('ok', false, 'reason', 'not_current_attempt');
  end if;
  v_status := case when r.attempts >= r.max_attempts then 'failed_final' else 'failed' end;
  update diagnostic_reports set status = v_status, failure_reason = left(coalesce(p_reason,'unknown'), 200)
   where id = r.id;
  perform lbd_log(r.id, r.license_hash, 'fail', v_status, 'system',
                  jsonb_build_object('attempt', p_attempt, 'reason', left(coalesce(p_reason,'unknown'), 200)));
  return jsonb_build_object('ok', true, 'status', v_status, 'attempts_remaining', r.max_attempts - r.attempts);
end $$;

/* ------------------------------------------------------------------ retrieve
   The only read path. Looks up by license_hash alone — there is no list, search or
   by-id read, so a report can only be reached by someone holding its license key.  */
create or replace function public.lbd_retrieve(p_license_hash text)
returns jsonb language plpgsql set search_path = public as $$
declare r diagnostic_reports;
begin
  select * into r from diagnostic_reports where license_hash = p_license_hash;
  if not found then
    perform lbd_log(null, p_license_hash, 'retrieve', 'not_found', 'buyer');
    return jsonb_build_object('found', false, 'reason', 'not_found');
  end if;
  if r.status = 'deleted' then
    perform lbd_log(r.id, r.license_hash, 'retrieve', 'deleted', 'buyer');
    return jsonb_build_object('found', false, 'reason', 'deleted');
  end if;
  if r.status <> 'complete' then
    perform lbd_log(r.id, r.license_hash, 'retrieve', 'not_ready', 'buyer', jsonb_build_object('status', r.status));
    return jsonb_build_object('found', false, 'reason', 'not_ready', 'status', r.status);
  end if;
  if r.retain_until < now() then
    perform lbd_log(r.id, r.license_hash, 'retrieve', 'expired', 'buyer');
    return jsonb_build_object('found', false, 'reason', 'expired');
  end if;
  perform lbd_log(r.id, r.license_hash, 'retrieve', 'served', 'buyer');
  return jsonb_build_object('found', true, 'inputs', r.inputs, 'report', r.report, 'retain_until', r.retain_until);
end $$;

/* ------------------------------------------------------------------ delete
   Scrubs inputs and report; keeps a tombstone (hash, product, dates, status) so the
   purchase cannot silently regenerate and so the audit trail still resolves.        */
create or replace function public.lbd_delete(p_license_hash text, p_report_id uuid, p_actor text, p_reason text)
returns jsonb language plpgsql set search_path = public as $$
declare r diagnostic_reports;
begin
  if p_actor not in ('buyer','admin') then raise exception 'lbd_delete: bad actor'; end if;
  select * into r from diagnostic_reports
   where (p_report_id is not null and id = p_report_id)
      or (p_report_id is null and license_hash = p_license_hash)
   for update;
  if not found then
    perform lbd_log(null, p_license_hash, 'delete', 'not_found', p_actor, jsonb_build_object('report_id', p_report_id));
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if r.status = 'deleted' then
    perform lbd_log(r.id, r.license_hash, 'delete', 'already_deleted', p_actor);
    return jsonb_build_object('ok', true, 'already_deleted', true);
  end if;
  update diagnostic_reports
     set status = 'deleted', inputs = null, report = null, failure_reason = null, deleted_at = now()
   where id = r.id;
  perform lbd_log(r.id, r.license_hash, 'delete', 'deleted', p_actor,
                  jsonb_build_object('reason', left(coalesce(p_reason,''), 200), 'previous_status', r.status));
  return jsonb_build_object('ok', true);
end $$;

/* ------------------------------------------------------------------ extend
   Retention can only move later; it can never drop below the 90-day floor.          */
create or replace function public.lbd_extend(p_license_hash text, p_report_id uuid, p_days int, p_actor text)
returns jsonb language plpgsql set search_path = public as $$
declare r diagnostic_reports; v_new timestamptz;
begin
  if p_days is null or p_days < 1 or p_days > 3650 then raise exception 'lbd_extend: days must be 1..3650'; end if;
  if p_actor not in ('admin','system') then raise exception 'lbd_extend: bad actor'; end if;
  select * into r from diagnostic_reports
   where (p_report_id is not null and id = p_report_id)
      or (p_report_id is null and license_hash = p_license_hash)
   for update;
  if not found then
    perform lbd_log(null, p_license_hash, 'extend', 'not_found', p_actor, jsonb_build_object('report_id', p_report_id));
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if r.status = 'deleted' then
    perform lbd_log(r.id, r.license_hash, 'extend', 'rejected_deleted', p_actor);
    return jsonb_build_object('ok', false, 'reason', 'deleted');
  end if;
  v_new := greatest(r.retain_until, now() + make_interval(days => p_days));
  update diagnostic_reports set retain_until = v_new where id = r.id;
  perform lbd_log(r.id, r.license_hash, 'extend', 'extended', p_actor,
                  jsonb_build_object('from', r.retain_until, 'to', v_new, 'days', p_days));
  return jsonb_build_object('ok', true, 'retain_until', v_new);
end $$;

/* ------------------------------------------------------------------ purge
   Daily job. Scrubs every record whose retention has passed.                       */
create or replace function public.lbd_purge_expired(p_limit int default 500)
returns jsonb language plpgsql set search_path = public as $$
declare r diagnostic_reports; n int := 0;
begin
  for r in select * from diagnostic_reports
            where status <> 'deleted' and retain_until < now()
            order by retain_until limit greatest(coalesce(p_limit,500),1)
            for update skip locked
  loop
    update diagnostic_reports
       set status = 'deleted', inputs = null, report = null, failure_reason = null, deleted_at = now()
     where id = r.id;
    perform lbd_log(r.id, r.license_hash, 'purge', 'retention_expired', 'system',
                    jsonb_build_object('retain_until', r.retain_until, 'previous_status', r.status));
    n := n + 1;
  end loop;
  return jsonb_build_object('ok', true, 'purged', n);
end $$;

revoke all on function
  public.lbd_log(uuid,text,text,text,text,jsonb),
  public.lbd_claim(text,text,text,jsonb,int,int,int),
  public.lbd_complete(uuid,int,jsonb),
  public.lbd_fail(uuid,int,text),
  public.lbd_retrieve(text),
  public.lbd_delete(text,uuid,text,text),
  public.lbd_extend(text,uuid,int,text),
  public.lbd_purge_expired(int)
from public, anon, authenticated;

grant execute on function
  public.lbd_log(uuid,text,text,text,text,jsonb),
  public.lbd_claim(text,text,text,jsonb,int,int,int),
  public.lbd_complete(uuid,int,jsonb),
  public.lbd_fail(uuid,int,text),
  public.lbd_retrieve(text),
  public.lbd_delete(text,uuid,text,text),
  public.lbd_extend(text,uuid,int,text),
  public.lbd_purge_expired(int)
to service_role;
grant select, insert, update on public.diagnostic_reports to service_role;
grant select, insert on public.diagnostic_report_events to service_role;
