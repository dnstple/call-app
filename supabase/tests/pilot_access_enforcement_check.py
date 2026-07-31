#!/usr/bin/env python3
"""
Pilot access enforcement proof (migrations 0103–0106).

Loads the ENTIRE migration chain into an ephemeral Postgres (function bodies
unchecked so the chain loads without the hosted extensions), applies the access
migrations, then asserts the authoritative capability contract at the RPC
boundary created by 0106:

  * a waitlisted authenticated account is DENIED (errcode pilot_access_inactive)
    at every gated feature RPC — booking, calls, messaging, message requests,
    conversations, reviews, payments and payouts;
  * a full account PASSES the guard at every one of those RPCs;
  * blocked and suspended state OVERRIDE full access, pilot cohort access, and
    a per-account feature override;
  * a service context (null auth.uid()) passes the guard (already-authorised
    background processing is unaffected);
  * moderation/reporting and Companion setup RPCs are NOT gated.

This complements the LiveKit/Stripe Edge-Function gates (checked in code review)
and the 0105 table triggers. Requires `pip install pgserver`.
Run:  python3 supabase/tests/pilot_access_enforcement_check.py
Exit code is non-zero if any assertion fails.
"""
import glob
import os
import sys
import tempfile

import pgserver

HERE = os.path.dirname(os.path.abspath(__file__))
MIG = os.path.join(HERE, "..", "migrations")

PRELUDE = """
create role anon; create role authenticated; create role service_role;
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create or replace function auth.role() returns text language sql stable as $$ select ''::text $$;
create or replace function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
create table if not exists auth.users(id uuid primary key, email text,
  email_confirmed_at timestamptz, raw_user_meta_data jsonb, created_at timestamptz default now());
create schema if not exists cron;
create or replace function cron.schedule(text,text,text) returns bigint language sql as $$ select 0::bigint $$;
create or replace function cron.unschedule(text) returns boolean language sql as $$ select true $$;
"""

GATED_SAMPLE = [
    ("booking",          "select * from public.get_available_slots(null,null,now(),now())"),
    ("booking",          "select public.get_booking_credit_state(null)"),
    ("calls",            "select public.call_join_eligibility(null)"),
    ("calls",            "select public.create_guest_invitation(null)"),
    ("messaging",        "select public.list_conversations()"),
    ("messaging",        "select public.send_message(null,'x')"),
    ("message_requests", "select public.respond_to_message_request(null,true)"),
    ("reviews",          "select public.submit_conversation_review(null,5::smallint,'a','b')"),
    ("reviews",          "select public.get_review_state(null)"),
    ("payments",         "select public.my_payments_ready(null)"),
    ("payments",         "select public.get_credit_summary()"),
    ("payouts",          "select public.get_my_companion_earnings_summary()"),
    ("payouts",          "select public.list_my_companion_earnings(10)"),
]

failures = []


def main():
    db = pgserver.get_server(tempfile.mkdtemp())
    run = db.psql
    run(PRELUDE)
    for ext in ("pgcrypto", "btree_gist", "citext", "uuid-ossp"):
        try:
            run(f'create extension if not exists "{ext}";')
        except Exception:
            pass
    for f in sorted(glob.glob(os.path.join(MIG, "0*.sql"))):
        if "0106_" in os.path.basename(f):
            continue
        run("set check_function_bodies=off;\n" + open(f).read().replace(
            "select pg_notify('pgrst', 'reload schema');", ""))
    run(open(os.path.join(MIG, "0106_rpc_boundary_access_guards.sql")).read().replace(
        "select pg_notify('pgrst', 'reload schema');", ""))
    run("create or replace function public._t(p text) returns text language plpgsql as "
        "$f$ begin execute p; return 'OK'; exception when others then return 'ERR:'||sqlerrm; end; $f$;")

    def one(uid, sql):
        u = "NULL" if uid is None else "'%s'" % uid
        out = db.psql(f"select set_config('request.jwt.claim.sub',{u},false); "
                      f"copy (select public._t($tq${sql}$tq$)) to stdout;")
        return out.strip().splitlines()[-1]

    def denied(uid, sql):
        return "pilot_access_inactive" in one(uid, sql).lower()

    def check(name, got, exp):
        ok = got == exp
        print(("PASS" if ok else "FAIL") + f" - {name}" + ("" if ok else f"  (got {got!r} exp {exp!r})"))
        if not ok:
            failures.append(name)

    W = "11111111-1111-4111-8111-111111111111"
    F = "22222222-2222-4222-8222-222222222222"
    B = "33333333-3333-4333-8333-333333333333"
    for x in (W, F, B):
        run(f"insert into auth.users(id,email_confirmed_at) values ('{x}',now()) on conflict do nothing;")
    run(f"insert into public.accounts(id,status) values ('{W}','active'),('{F}','active'),('{B}','active') on conflict do nothing;")
    run(f"update public.account_access set access_level='waitlist',application_status='incomplete' where account_id='{W}';")
    run(f"update public.account_access set access_level='full',application_status='approved' where account_id='{F}';")

    wl = sum(1 for _, c in GATED_SAMPLE if denied(W, c))
    fp = sum(1 for _, c in GATED_SAMPLE if not denied(F, c))
    check(f"waitlist denied at all {len(GATED_SAMPLE)} gated RPCs", wl, len(GATED_SAMPLE))
    check(f"full passes guard at all {len(GATED_SAMPLE)} gated RPCs", fp, len(GATED_SAMPLE))

    run(f"update public.account_access set access_level='blocked',application_status='approved' where account_id='{B}';")
    run(f"insert into public.account_feature_overrides(account_id,feature_key,enabled) values ('{B}','messaging',true) "
        f"on conflict (account_id,feature_key) do update set enabled=true;")
    check("blocked overrides account feature override", denied(B, "select public.list_conversations()"), True)
    run(f"update public.account_access set access_level='full',application_status='suspended' where account_id='{B}';")
    check("suspended overrides full access", denied(B, "select public.list_conversations()"), True)
    run("insert into public.pilot_cohorts(id,name,status) values ('44444444-4444-4444-8444-444444444444','C','active') on conflict do nothing;")
    run("insert into public.cohort_feature_access(cohort_id,feature_key,enabled) values ('44444444-4444-4444-8444-444444444444','messaging',true) on conflict do nothing;")
    run(f"update public.account_access set access_level='pilot',application_status='suspended',cohort_id='44444444-4444-4444-8444-444444444444' where account_id='{B}';")
    check("suspended overrides pilot cohort access", denied(B, "select public.list_conversations()"), True)

    check("service (null auth.uid()) passes guard", denied(None, "select public.list_conversations()"), False)
    check("moderation report RPC not gated", db.psql(
        "copy (select count(*) from pg_proc where proname='report_conversation_issue__impl') to stdout").strip(), "0")
    check("Companion availability setup RPC not gated", db.psql(
        "copy (select count(*) from pg_proc where proname='replace_companion_availability__impl') to stdout").strip(), "0")

    print()
    if failures:
        print(f"{len(failures)} assertion(s) FAILED: {failures}")
        sys.exit(1)
    print("All pilot access enforcement assertions passed.")


if __name__ == "__main__":
    main()
