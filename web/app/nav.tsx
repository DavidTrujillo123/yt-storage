'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { api } from '@/lib/api';

export function Nav() {
  const pathname = usePathname();
  const router = useRouter();

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
        <span className="spacer" />
        <span className="small muted mono" title="Which build this browser is running">
          build {process.env.NEXT_PUBLIC_BUILD}
        </span>
        <button onClick={signOut}>Sign out</button>
      </nav>
    </header>
  );
}
