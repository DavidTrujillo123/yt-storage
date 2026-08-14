import type { Metadata } from 'next';
import { Nav } from './nav';
import './globals.css';

export const metadata: Metadata = {
  title: 'yt-storage',
  description: 'A self-hosted cloud that keeps its bytes on YouTube',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Nav />
        <main>{children}</main>
      </body>
    </html>
  );
}
