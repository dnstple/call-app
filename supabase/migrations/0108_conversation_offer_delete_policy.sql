-- 0108 — Allow a Companion to DELETE their own standard conversation offers.
--
-- 0004 deliberately shipped no delete policy (offers were archive-only). We now
-- let owners remove an offer outright from Availability & rates. Booking history
-- is still protected: bookings.offer_id references conversation_offers(id) with
-- no cascade, so the database itself blocks deleting an offer that has any
-- bookings (the client maps that FK error to "disable it instead"). Only
-- unused offers can actually be destroyed. Additive; apply hosted after 0107.

set search_path = '';

drop policy if exists "offers: delete" on public.conversation_offers;
create policy "offers: delete" on public.conversation_offers
  for delete to authenticated
  using (app_private.can_edit_profile(companion_profile_id));

select pg_notify('pgrst', 'reload schema');
