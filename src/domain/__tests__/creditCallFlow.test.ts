import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const AC = readFileSync('supabase/migrations/0168_auto_complete_credit_bookings.sql', 'utf8');
const EL = readFileSync('supabase/migrations/0169_credit_call_join_eligibility.sql', 'utf8');
const BD = readFileSync('src/pages/BookingDetail.tsx', 'utf8');
const CP = readFileSync('src/pages/CallPage.tsx', 'utf8');

describe('credit call flow wiring (0168/0169)', () => {
  it('auto-completes ended credit calls and pays only genuine delivery', () => {
    expect(AC).toContain('function public.auto_complete_credit_bookings');
    expect(AC).toContain('offer_id is null');
    expect(AC).toContain("b.status = 'companion_confirmed'");
    expect(AC).toContain('b.companion_joined_at is not null');
    expect(AC).toContain("cron.schedule('auto-complete-credit-bookings'");
  });

  it('meeting gate accepts booked / companion_confirmed', () => {
    expect(EL).toContain("v_b.status not in ('confirmed', 'booked', 'companion_confirmed')");
  });

  it('role-agreement signing also grants the pilot consent', () => {
    expect(EL).toContain('function public.record_role_agreement');
    expect(EL).toContain("acknowledge_consent(v_profile, p_role || '_pilot')");
  });

  it('companion sees a confirm button; call page marks the companion joined', () => {
    expect(BD).toContain("booking.status === 'booked'");
    expect(BD).toContain('confirmBooking(booking.id)');
    expect(CP).toContain('markCompanionJoined(bookingId)');
  });
});
