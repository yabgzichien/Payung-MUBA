import type { Metadata } from 'next';
import './globals.css';
import { ProtectionFlowProvider } from './protect/_lib/FlowState';

export const metadata: Metadata = {
  title: 'Payung: Protected price, quoted live',
  icons: {
    icon: { url: '/favicon.svg', type: 'image/svg+xml' },
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/*
          Archivo, not Instrument Sans. Instrument Sans is one of the handful of
          faces the current wave of generated interfaces has converged on, so it
          reads as a default rather than a decision. Archivo is a grotesque with
          a taller x-height, tighter apertures and a genuine 100–900 range — it
          holds authority at display sizes and stays legible at 13px, and its
          slightly industrial character sits naturally beside IBM Plex Mono,
          which carries every number in this app.
        */}
        <link
          href="https://fonts.googleapis.com/css2?family=Archivo:ital,wght@0,400..800;1,400..600&family=IBM+Plex+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <ProtectionFlowProvider>{children}</ProtectionFlowProvider>
      </body>
    </html>
  );
}
