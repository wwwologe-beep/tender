import type { Metadata } from 'next';
import { Geist } from 'next/font/google';
import './globals.css';
import { I18nProvider } from '@/lib/i18n';
import { AuthProvider } from '@/lib/auth-context';

const geist = Geist({ subsets: ['latin'], variable: '--font-geist-sans' });

export const metadata: Metadata = {
  title:       'mushebi.ge — Любые задачи в Грузии',
  description: 'Грузчики, вывоз мусора, переезды, уборка и мастера. Опишите задачу — исполнители предложат цены за 10 минут.',
  openGraph: {
    title:       'mushebi.ge',
    description: 'Тендерная платформа услуг в Грузии',
    locale:      'ru_GE',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru" className={`${geist.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-[#F6F6F6]">
        <I18nProvider>
          <AuthProvider>
            {children}
          </AuthProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
