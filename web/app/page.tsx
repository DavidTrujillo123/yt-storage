'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Client-side, not `redirect()`: this is a static export, so there is no server
 * left to answer with a 307 — a build-time redirect just produces an error page.
 */
export default function Home() {
  const router = useRouter();
  useEffect(() => router.replace('/files'), [router]);
  return <p className="muted">Loading…</p>;
}
