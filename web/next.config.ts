import type { NextConfig } from 'next';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A static export, served by the NestJS process.
 *
 * There is no frontend server: every page here is a client component that talks
 * to /api on its own origin, so `next build` produces plain .html and .js that
 * Nest hands out. One process, one port, and the httpOnly session cookie works
 * without a proxy or CORS because there is only ever one origin.
 */
function version(): string {
  const pkg = readFileSync(join(__dirname, 'package.json'), 'utf8');
  return (JSON.parse(pkg) as { version: string }).version;
}

const config: NextConfig = {
  output: 'export',
  distDir: '.next',
  // No Next server means no image optimiser.
  images: { unoptimized: true },
  // Stamped into the page so "which version is this browser running?" is a
  // question anyone can answer by looking, instead of an argument. Browsers
  // cache these files aggressively and a stale bundle looks exactly like a bug
  // that will not go away.
  //
  // Read from package.json rather than from git: a release is built inside a
  // container from a copied tree, where `git describe` has no repository to
  // describe. Bumping the version and tagging it are therefore one step — see
  // the release note in the README.
  env: { NEXT_PUBLIC_BUILD: `v${version()}` },
};

export default config;
