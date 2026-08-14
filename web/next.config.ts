import type { NextConfig } from 'next';

/**
 * A static export, served by the NestJS process.
 *
 * There is no frontend server: every page here is a client component that talks
 * to /api on its own origin, so `next build` produces plain .html and .js that
 * Nest hands out. One process, one port, and the httpOnly session cookie works
 * without a proxy or CORS because there is only ever one origin.
 */
const config: NextConfig = {
  output: 'export',
  distDir: '.next',
  // No Next server means no image optimiser.
  images: { unoptimized: true },
  // Stamped into the page so "is the browser running the current build?" is a
  // question anyone can answer by looking, instead of an argument. Browsers
  // cache these files aggressively and a stale bundle looks exactly like a bug
  // that will not go away.
  env: { NEXT_PUBLIC_BUILD: new Date().toISOString().slice(5, 16).replace('T', ' ') },
};

export default config;
