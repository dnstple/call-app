-- 0109 — In-app contact messages (no email needed).
--
-- Visitors (signed in OR anonymous) submit a message from the landing page; it
-- is stored here and read by support inside the app. All access is via RPCs:
--   * public.submit_contact_message — anyone (anon + authenticated) may send;
--     validated + length-capped; records the sender account when signed in.
--   * public.admin_list_contact_messages / admin_mark_contact_handled —
--     support admins only (app_private.require_support), audited by handled_by.
-- No client table policies (RLS on, no policy => browser can't read/write the
-- table directly). Additive; apply hosted after 0108.

set search_path = '';

create table if not exists public.contact_messages (
  id              uuid primary key default gen_random_uuid(),
  from_account_id uuid references public.accounts(id) on delete set null,
  name            text,
  email           text,
  message         text not null,
  handled         boolean not null default false,
  handled_at      timestamptz,
  handled_by      uuid references public.accounts(id),
  created_at      timestamptz not null default now()
);
alter table public.contact_messages enable row level security;  -- RPC-only access

create index if not exists contact_messages_created_idx
  on public.contact_messages (handled, created_at desc);

-- ---------- submit (anyone) ----------
create or replace function public.submit_contact_message(p_name text, p_email text, p_message text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_msg text := btrim(coalesce(p_message, ''));
begin
  if v_msg = '' then
    raise exception 'message_required: please write a message' using errcode = 'P0001';
  end if;
  if char_length(v_msg) > 4000 then
    raise exception 'message_too_long: please shorten your message' using errcode = 'P0001';
  end if;
  insert into public.contact_messages (from_account_id, name, email, message)
  values (auth.uid(), left(nullif(btrim(coalesce(p_name,'')), ''), 200),
          left(nullif(btrim(coalesce(p_email,'')), ''), 320), v_msg)
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;
revoke all on function public.submit_contact_message(text, text, text) from public;
grant execute on function public.submit_contact_message(text, text, text) to anon, authenticated;

-- ---------- support: list ----------
create or replace function public.admin_list_contact_messages(
  p_handled boolean default null, p_limit integer default 50, p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb; v_total int; v_lim int := least(greatest(coalesce(p_limit,50),1),200); v_off int := greatest(coalesce(p_offset,0),0);
begin
  perform app_private.require_support();
  select count(*) into v_total from public.contact_messages
   where (p_handled is null or handled = p_handled);
  select coalesce(jsonb_agg(row_to_json(x)::jsonb), '[]'::jsonb) into v from (
    select cm.id, cm.name, cm.email, cm.message, cm.handled, cm.created_at,
           cm.from_account_id is not null as from_member
    from public.contact_messages cm
    where (p_handled is null or cm.handled = p_handled)
    order by cm.created_at desc
    limit v_lim offset v_off
  ) x;
  return jsonb_build_object('total', v_total, 'limit', v_lim, 'offset', v_off, 'rows', v);
end;
$$;
revoke all on function public.admin_list_contact_messages(boolean, integer, integer) from public, anon;
grant execute on function public.admin_list_contact_messages(boolean, integer, integer) to authenticated;

-- ---------- support: mark handled ----------
create or replace function public.admin_mark_contact_handled(p_id uuid, p_handled boolean default true)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_support();
  update public.contact_messages set
    handled = p_handled,
    handled_at = case when p_handled then now() else null end,
    handled_by = case when p_handled then auth.uid() else null end
  where id = p_id;
  return jsonb_build_object('id', p_id, 'handled', p_handled);
end;
$$;
revoke all on function public.admin_mark_contact_handled(uuid, boolean) from public, anon;
grant execute on function public.admin_mark_contact_handled(uuid, boolean) to authenticated;

select pg_notify('pgrst', 'reload schema');
