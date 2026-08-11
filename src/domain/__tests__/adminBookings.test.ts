import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const MIG = readFileSync('supabase/migrations/0156_admin_list_bookings.sql', 'utf8');

describe('admin_list_bookings (0156)', () => {
  it('is support-gated and returns kind, time and full cost breakdown', () => {
    expect(MIG).toContain('function public.admin_list_bookings(');
    expect(MIG).toContain('app_private.require_support()');
    expect(MIG).toContain("case when b.is_trial then 'Trial' else 'Paid' end as kind");
    expect(MIG).toContain('b.starts_at');
    expect(MIG).toContain('b.price_minor');
    expect(MIG).toContain('b.platform_fee_minor');
    expect(MIG).toContain('b.companion_amount_minor');
  });

  it('joins member + companion names and the offer type', () => {
    expect(MIG).toContain('join public.profiles m on m.id = b.member_profile_id');
    expect(MIG).toContain('join public.profiles c on c.id = b.companion_profile_id');
    expect(MIG).toContain('left join public.conversation_offers o on o.id = b.offer_id');
  });

  it('locks the function down to authenticated + support only', () => {
    expect(MIG).toContain('revoke all on function public.admin_list_bookings(integer) from public, anon');
    expect(MIG).toContain('grant execute on function public.admin_list_bookings(integer) to authenticated');
  });
});
