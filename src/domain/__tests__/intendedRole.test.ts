import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const SQL = readFileSync('supabase/migrations/0151_capture_intended_role.sql', 'utf8');
const SERVICE = readFileSync('src/auth/authService.ts', 'utf8');
const REGISTER = readFileSync('src/auth/authPages.tsx', 'utf8');

describe('capture intended role (0151)', () => {
  it('adds a constrained accounts.intended_role column', () => {
    expect(SQL).toContain('add column if not exists intended_role text');
    expect(SQL).toContain("intended_role in ('member', 'coordinator', 'companion')");
  });

  it('seeds intended_role from auth metadata but never overwrites a set value', () => {
    expect(SQL).toContain("u.raw_user_meta_data->>'intended_role'");
    expect(SQL).toContain('and intended_role is null');
  });

  it('exposes a self-service set_intended_role fallback RPC', () => {
    expect(SQL).toContain('function public.set_intended_role(p_role text)');
    expect(SQL).toContain('grant execute on function public.set_intended_role(text) to authenticated');
  });

  it('backfills existing accounts from metadata and from the owned profile role', () => {
    expect(SQL).toContain("nullif(u.raw_user_meta_data->>'intended_role', '') in ('member', 'coordinator', 'companion')");
    expect(SQL).toContain('pr.role::text');
    expect(SQL).toContain("pa.access_role = 'owner'");
  });
});

const CONSOLE_SQL = readFileSync('supabase/migrations/0152_admin_console_intended_role.sql', 'utf8');
const CONSOLE_UI = readFileSync('src/pages/InternalAccess.tsx', 'utf8');

describe('surface intended_role in the access console (0152)', () => {
  it('both admin RPCs return intended_role', () => {
    expect(CONSOLE_SQL).toContain('function public.admin_list_accounts(');
    expect(CONSOLE_SQL).toContain('function public.admin_account_detail(');
    expect(CONSOLE_SQL).toContain("'intended_role', v_intended_role");
    expect(CONSOLE_SQL).toContain('ac.intended_role');
  });

  it('the role filter falls back to intended_role so drop-offs are filterable', () => {
    expect(CONSOLE_SQL).toContain('coalesce(role, intended_role) = p_role');
  });

  it('the console renders the intended role when no profile role exists yet', () => {
    expect(CONSOLE_UI).toContain('r.intended_role');
    expect(CONSOLE_UI).toContain('d.intended_role');
    expect(CONSOLE_UI).toContain('(intended)');
  });
});

describe('frontend writes intended_role at sign-up', () => {
  it('passes a validated role into auth.signUp user metadata', () => {
    expect(SERVICE).toContain('intendedRole?: string');
    expect(SERVICE).toContain('intended_role: role');
    expect(SERVICE).toContain("VALID_ROLES = ['member', 'coordinator', 'companion']");
  });

  it('the register page forwards the chosen role to signUp', () => {
    expect(REGISTER).toContain('signUp(email.trim(), password, role || undefined)');
  });
});
