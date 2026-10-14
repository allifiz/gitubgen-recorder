import type { Metadata } from 'next';
import './styles.css';

export const metadata: Metadata = {
  title: 'Gitubgen Recorder',
  description: 'Project V2 status recorder for Gitubgen KPI'
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}
