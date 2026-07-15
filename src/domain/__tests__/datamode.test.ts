// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { clearDataModeOverride, getDataMode, setDataMode } from '../../config/dataMode';
import { getRepository, NotImplementedError } from '../../repositories';
import { mockRepository } from '../../repositories/mock';
import { supabaseRepository } from '../../repositories/supabase';

describe('data mode resolution', () => {
  beforeEach(() => {
    clearDataModeOverride();
  });

  it('defaults to mock', () => {
    expect(getDataMode()).toBe('mock');
  });

  it('honours a runtime override and can clear it', () => {
    setDataMode('supabase');
    expect(getDataMode()).toBe('supabase');
    setDataMode('mock');
    expect(getDataMode()).toBe('mock');
    setDataMode('supabase');
    clearDataModeOverride();
    expect(getDataMode()).toBe('mock');
  });

  it('resolves the matching repository', () => {
    expect(getRepository('mock').mode).toBe('mock');
    expect(getRepository('supabase').mode).toBe('supabase');
    expect(getRepository().mode).toBe(getDataMode());
  });
});

describe('mock repository (adapts the local store)', () => {
  it('pings ok and serves seeded reads', async () => {
    const ping = await mockRepository.ping();
    expect(ping.ok).toBe(true);
    const users = await mockRepository.fetchUsers();
    expect(users.length).toBeGreaterThanOrEqual(14);
    const config = await mockRepository.fetchPlatformConfig();
    expect(config.standardCommissionPct).toBe(2);
    const notifications = await mockRepository.fetchNotifications('coord-alex');
    expect(notifications.every((n) => n.userId === 'coord-alex')).toBe(true);
  });
});

describe('supabase repository (foundation)', () => {
  it('fails ping gracefully when unconfigured', async () => {
    const ping = await supabaseRepository.ping();
    expect(ping.ok).toBe(false);
    expect(ping.message).toMatch(/not set|configured/i);
  });

  it('reports unmigrated reads as NotImplementedError', async () => {
    await expect(supabaseRepository.fetchBookings()).rejects.toBeInstanceOf(NotImplementedError);
    await expect(supabaseRepository.fetchRatings()).rejects.toThrow(/Stage 2B/);
  });
});
