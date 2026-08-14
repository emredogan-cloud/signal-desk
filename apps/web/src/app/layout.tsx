import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'signal-desk — AI Intelligence Studio',
  description: 'Gerçek zamanlı AI ve teknoloji istihbaratı, X içerik operasyonları.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="tr">
      <body>{children}</body>
    </html>
  );
}
