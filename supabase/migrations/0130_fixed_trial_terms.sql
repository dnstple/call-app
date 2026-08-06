-- 0130 — Fixed trial terms: every trial is 30 minutes for £5 (500p).
--
-- Companions no longer choose the trial price or duration. Conversation offers
-- are written straight to the table (no RPC), so a BEFORE trigger forces any
-- 'trial' row to 30 minutes / 500p regardless of what the client sends. Existing
-- trials are normalised to the same terms. Standard ('single') offers are
-- untouched. Additive; apply after 0129.

set search_path = '';

-- Normalise existing trials to the fixed terms.
update public.conversation_offers
   set price_minor = 500, duration_minutes = 30
 where offer_type = 'trial' and (price_minor <> 500 or duration_minutes <> 30);

-- Force fixed terms on every future insert/update of a trial offer.
create or replace function app_private.enforce_trial_offer_terms()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.offer_type = 'trial' then
    new.price_minor := 500;       -- £5.00
    new.duration_minutes := 30;   -- 30 minutes
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_trial_offer_terms on public.conversation_offers;
create trigger trg_enforce_trial_offer_terms
  before insert or update on public.conversation_offers
  for each row execute function app_private.enforce_trial_offer_terms();

select pg_notify('pgrst', 'reload schema');
