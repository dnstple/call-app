/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_DATA_SOURCE?: string;
  /** Legacy alias for VITE_DATA_SOURCE. */
  readonly VITE_DATA_MODE?: string;
  readonly VITE_APP_URL?: string;
  /** 'on' re-enables SMS phone verification (off while Twilio is paused). */
  readonly VITE_PHONE_VERIFICATION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
