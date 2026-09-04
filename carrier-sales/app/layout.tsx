import type { Metadata } from "next";
import type { ReactNode } from "react";

export const runtime = "nodejs";

export const metadata: Metadata = {
  title: "Carrier Sales | Scaffold",
  description: "Local foundation for the HappyRobot carrier-sales challenge.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: "3rem auto", padding: "0 1.5rem", maxWidth: "48rem", lineHeight: 1.6 }}>
        {children}
      </body>
    </html>
  );
}
