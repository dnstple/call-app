import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { assertProductionEnv } from './config/validateEnv';

const rootEl = document.getElementById('root')!;

try {
  // Fail fast on a mis-configured production build rather than shipping a broken
  // app (dev/mock only warns — see validateEnv).
  assertProductionEnv();
  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
} catch (err) {
  // Never a blank page: surface the configuration problem plainly.
  const message = err instanceof Error ? err.message : String(err);
  rootEl.innerHTML =
    '<div style="max-width:560px;margin:64px auto;padding:24px;font-family:system-ui,sans-serif;' +
    'line-height:1.5;color:#201c19">' +
    '<h1 style="font-size:1.3rem;margin:0 0 12px">This deployment is misconfigured</h1>' +
    '<p style="margin:0 0 12px;color:#6f6a65">The app cannot start until the environment is fixed. ' +
    'Details (also in the browser console):</p>' +
    '<pre style="white-space:pre-wrap;background:#f6f3ef;border-radius:12px;padding:14px;font-size:0.85rem">' +
    message.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string)) +
    '</pre></div>';
  if (typeof console !== 'undefined') console.error(err);
}
