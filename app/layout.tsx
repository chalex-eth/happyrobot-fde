import type { ReactNode } from 'react';
import './globals.css';
export const metadata = { title: 'Load desk · Carrier sales', description: 'Local carrier sales TMS console' };
export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
