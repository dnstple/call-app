import { getDataMode, type DataMode } from '../config/dataMode';
import { mockRepository } from './mock';
import { supabaseRepository } from './supabase';
import type { DataRepository } from './types';

export type { DataRepository, RepositoryPing } from './types';
export { NotImplementedError } from './types';

/** Resolve the active repository (or a specific one, e.g. for connection tests). */
export function getRepository(mode: DataMode = getDataMode()): DataRepository {
  return mode === 'supabase' ? supabaseRepository : mockRepository;
}
