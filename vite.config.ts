/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['src/domain/__tests__/**/*.test.{ts,tsx}'],
    // Tests must not inherit the developer's .env: the suite assumes a
    // mock-mode, unconfigured baseline and switches modes explicitly.
    env: {
      VITE_DATA_SOURCE: 'mock',
      VITE_DATA_MODE: '',
      VITE_SUPABASE_URL: '',
      VITE_SUPABASE_ANON_KEY: '',
    },
  },
});
