import { useState } from 'react';
import { Check, Database, FlaskConical, Loader2 } from 'lucide-react';
import { Modal } from './ui';
import { getDataMode, setDataMode, type DataMode } from '../config/dataMode';
import { isSupabaseConfigured, supabaseEnv } from '../supabase/client';
import { getRepository } from '../repositories';

export function DataModePanel({ onClose }: { onClose: () => void }) {
  const current = getDataMode();
  const [selected, setSelected] = useState<DataMode>(current);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const configured = isSupabaseConfigured();
  const env = supabaseEnv();

  async function testConnection() {
    setTesting(true);
    setResult(null);
    const r = await getRepository('supabase').ping();
    setResult(r);
    setTesting(false);
  }

  function apply() {
    setDataMode(selected);
    // Reload so every module resolves the new mode consistently (dev tool only).
    window.location.reload();
  }

  return (
    <Modal title="Data mode" onClose={onClose}>
      <div className="col" style={{ gap: 12 }}>
        <p className="muted" style={{ margin: 0 }}>
          Supabase mode uses real sign-in and shows only the authenticated account’s own data.
          Features not yet migrated (conversations, packages, ratings, notifications, favourites)
          show intentional empty states — they never fall back to the mock demo data.
        </p>

        <button
          className="card card-tight card-click card-selectable row"
          aria-pressed={selected === 'mock'}
          onClick={() => setSelected('mock')}
        >
          <span className="icon-btn" style={{ background: 'var(--color-surface-muted)', pointerEvents: 'none' }} aria-hidden="true">
            <FlaskConical size={20} />
          </span>
          <span className="col grow" style={{ gap: 2, textAlign: 'left' }}>
            <span className="bold">Mock (default)</span>
            <span className="faint">Seeded fictional data, saved in this browser. No network.</span>
          </span>
          {current === 'mock' && <span className="badge badge-neutral">Current</span>}
        </button>

        <button
          className="card card-tight card-click card-selectable row"
          aria-pressed={selected === 'supabase'}
          onClick={() => setSelected('supabase')}
        >
          <span className="icon-btn" style={{ background: 'var(--color-surface-muted)', pointerEvents: 'none' }} aria-hidden="true">
            <Database size={20} />
          </span>
          <span className="col grow" style={{ gap: 2, textAlign: 'left' }}>
            <span className="bold">Supabase (foundation)</span>
            <span className="faint">
              {configured
                ? `Configured — ${env.url}`
                : 'Not configured yet. Copy .env.example to .env and add your project keys.'}
            </span>
          </span>
          {current === 'supabase' && <span className="badge badge-neutral">Current</span>}
        </button>

        <div className="row wrap" style={{ gap: 10 }}>
          <button className="btn btn-secondary btn-small" onClick={testConnection} disabled={testing}>
            {testing ? <Loader2 size={16} className="reveal" aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}
            Test Supabase connection
          </button>
        </div>

        {result && (
          <div className={`banner ${result.ok ? 'banner-success' : 'banner-danger'}`} role="status">
            {result.message}
          </div>
        )}

        <div className="row between mt-2">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={apply} disabled={selected === current}>
            Switch to {selected === 'mock' ? 'mock' : 'Supabase'} mode
          </button>
        </div>
      </div>
    </Modal>
  );
}
