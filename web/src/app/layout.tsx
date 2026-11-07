import type { Metadata } from "next";
import type { ReactNode } from "react";
import { identity } from "../../../shared/identity";
import "./globals.css";

export const metadata: Metadata = {
  title: identity.brandName,
  description: "Website uptime and performance monitoring.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
