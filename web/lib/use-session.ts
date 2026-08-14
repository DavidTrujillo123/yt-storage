'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from './api';

export interface Session {
  id: string;
  email: string;
}

/**
 * Guards a page. The session cookie is httpOnly, so the only way to know
 * whether it is still valid is to ask the API; a 401 means the row behind it
 * is gone — logout here is a delete, not an expiry check.
 */
export function useSession(): Session | null {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    let live = true;
    api<Session>('/auth/me')
      .then((me) => live && setSession(me))
      .catch((error) => {
        if (error instanceof ApiError && error.status === 401) router.replace('/login');
      });
    return () => {
      live = false;
    };
  }, [router]);

  return session;
}
