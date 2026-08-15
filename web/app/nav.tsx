'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import type { Status } from '@/lib/api';

export function Nav() {
  const pathname = usePathname();
  const router = useRouter();
  // Setup is offered only while it has something left to do. An instance that
  // can already upload does not need a permanent link to its own onboarding.
  const [needsSetup, setNeedsSetup] = useState(false);

  useEffect(() => {
    if (pathname === '/login') return;
    api<Status>('/status')
      .then((status) => setNeedsSetup(!status.canUpload))
      .catch(() => undefined);
  }, [pathname]);

  if (pathname === '/login') return null;

  async function signOut() {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    router.replace('/login');
  }

  return (
    <header className="top">
      <nav>
        <span className="brand">yt-storage</span>
        <Link href="/files" data-active={pathname.startsWith('/files')}>
          Files
        </Link>
        <Link href="/accounts" data-active={pathname.startsWith('/accounts')}>
          Accounts
        </Link>
        {(needsSetup || pathname.startsWith('/setup')) && (
          <Link href="/setup" data-active={pathname.startsWith('/setup')}>
            Setup
          </Link>
        )}
        <span className="spacer" />
        <span className="small muted mono" title="Which version this browser is running">
          {process.env.NEXT_PUBLIC_BUILD}
        </span>
        <button onClick={signOut}>Sign out</button>
      </nav>
    </header>
  );
}
