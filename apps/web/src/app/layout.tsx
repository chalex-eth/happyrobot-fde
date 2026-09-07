import type { ReactNode } from 'react';
import './globals.css';
export const metadata = {
  title: 'HappyRobot Logistics · Operations',
  description: 'HappyRobot Logistics operations workspace',
};
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
