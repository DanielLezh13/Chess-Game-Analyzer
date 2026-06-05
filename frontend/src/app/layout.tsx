import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Chess Review",
  description: "Review chess games with move classifications, evaluations, opening detection, and account-backed game history.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
