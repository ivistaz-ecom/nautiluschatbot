import type { Metadata } from 'next';
import './globals.css';
import { AuthProvider } from '@/lib/auth';

export const metadata: Metadata = {
  title: 'Nautilus Shipping — Knowledge Base',
  description: 'AI-powered knowledge base for Nautilus Shipping',
  icons: {
    icon: '/white-logo.webp',
    shortcut: '/white-logo.webp',
    apple: '/white-logo.webp',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="bg-brand text-white antialiased" suppressHydrationWarning>
        <AuthProvider>
          {children}
        </AuthProvider>
      </body>
    </html>
  );
}
