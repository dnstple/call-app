/**
 * Profile extras (migration 0121): preferred name, country of residence,
 * connected places/cultures, per-language fluency. Runtime behaviour is proven
 * on a from-scratch schema in stage validation; these lock the source contract.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FLUENCY_OPTIONS, EMPTY_SIGNUP, STEP_SEQUENCES } from '../../signup/types';

const ROOT = join(__dirname, '..', '..', '..');
const M = readFileSync(join(ROOT, 'supabase', 'migrations', '0121_profile_extras.sql'), 'utf-8');
const COMPLETE = readFileSync(join(ROOT, 'src', 'signup', 'completeSupabase.ts'), 'utf-8');

describe('0121 profile extras migration', () => {
  it('adds the columns additively without touching the completion RPCs', () => {
    for (const col of ['preferred_name', 'country_of_residence', 'connected_places', 'language_fluency']) {
      expect(M).toContain(`add column if not exists ${col}`);
    }
    expect(M).not.toMatch(/create or replace function public\.complete_(member|companion|coordinator)_signup/);
  });
  it('exposes an owner-only set_profile_extras RPC', () => {
    expect(M).toContain('create or replace function public.set_profile_extras');
    expect(M).toContain("access_role = 'owner'");
    expect(M).toContain('grant execute on function public.set_profile_extras(text, text, text[], jsonb) to authenticated');
    expect(M).toContain('to authenticated');
  });
});

describe('signup wiring', () => {
  it('records fluency per language with the four levels', () => {
    expect(FLUENCY_OPTIONS).toEqual(['Native or bilingual', 'Fluent', 'Conversational', 'Basic']);
    expect(typeof EMPTY_SIGNUP.languageFluency).toBe('object');
  });
  it('carries the new optional fields in the signup draft', () => {
    expect(EMPTY_SIGNUP).toHaveProperty('preferredName');
    expect(EMPTY_SIGNUP).toHaveProperty('countryOfResidence');
    expect(EMPTY_SIGNUP).toHaveProperty('connectedPlaces');
  });
  it('moved pricing and packages out of the companion signup sequence', () => {
    expect(STEP_SEQUENCES.companion).not.toContain('pricing');
    expect(STEP_SEQUENCES.companion).not.toContain('packages');
  });
  it('persists the extras after completion via set_profile_extras', () => {
    expect(COMPLETE).toContain("client.rpc('set_profile_extras'");
    expect(COMPLETE).toContain('await applyProfileExtras(data)');
  });
});
