'use client';

import { useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { useI18n, Lang } from '@/lib/i18n';
import { AuthModal } from './AuthModal';

const LANGS: { code: Lang; flag: string; label: string }[] = [
  { code: 'ru', flag: '🇷🇺', label: 'RU' },
  { code: 'en', flag: '🇬🇧', label: 'EN' },
  { code: 'ka', flag: '🇬🇪', label: 'KA' },
];

export function Navbar() {
  const { session, logout } = useAuth();
  const { lang, setLang, t } = useI18n();
  const router = useRouter();

  const [authOpen,    setAuthOpen]    = useState(false);
  const [langOpen,    setLangOpen]    = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

  function handleProfileClick() {
    if (session) {
      setProfileOpen(p => !p);
    } else {
      setAuthOpen(true);
    }
  }

  return (
    <>
      <header className="bg-white/80 backdrop-blur-md border-b border-gray-100 sticky top-0 z-30">
        <div className="max-w-2xl mx-auto px-5 py-3 flex items-center justify-between gap-3">

          {/* Brand */}
          <Link href="/" className="shrink-0 flex items-center">
            <Image
              src="/logo.svg"
              alt="Mushebi.ge"
              width={168}
              height={48}
              priority
              className="h-10 w-auto"
            />
          </Link>

          {/* Right controls */}
          <div className="flex items-center gap-2">

            {/* Language switcher */}
            <div className="relative">
              <button
                onClick={() => { setLangOpen(p => !p); setProfileOpen(false); }}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-sm font-medium text-gray-600 hover:bg-gray-100 transition-colors"
              >
                {(() => { const l = LANGS.find(l => l.code === lang)!; return <>{l.flag} <span>{l.label}</span></>; })()}
                <span className="text-gray-400 text-[10px] ml-0.5">▾</span>
              </button>

              {langOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setLangOpen(false)} />
                  <div className="absolute right-0 top-full mt-1.5 bg-white border border-gray-100 rounded-2xl shadow-lg overflow-hidden z-20 min-w-[100px]">
                    {LANGS.map(l => (
                      <button
                        key={l.code}
                        onClick={() => { setLang(l.code); setLangOpen(false); }}
                        className={[
                          'flex items-center gap-2 w-full px-4 py-2.5 text-sm hover:bg-gray-50 transition-colors',
                          lang === l.code ? 'font-semibold text-[#1D1D1F]' : 'text-gray-600',
                        ].join(' ')}
                      >
                        {l.flag} {l.label}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* Profile / auth button */}
            <div className="relative">
              <button
                onClick={handleProfileClick}
                className={[
                  'flex items-center gap-2 px-3 py-1.5 rounded-xl text-sm font-medium transition-colors',
                  session
                    ? 'bg-[#1D1D1F] text-white hover:bg-[#333]'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200',
                ].join(' ')}
              >
                {session ? (
                  <>
                    <span className="text-base">👤</span>
                    <span className="hidden sm:inline">{t.myOrders}</span>
                  </>
                ) : (
                  <>
                    <span className="text-base">👤</span>
                    <span className="hidden sm:inline">{t.myOrders}</span>
                  </>
                )}
              </button>

              {/* Profile dropdown */}
              {session && profileOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setProfileOpen(false)} />
                  <div className="absolute right-0 top-full mt-1.5 bg-white border border-gray-100 rounded-2xl shadow-lg overflow-hidden z-20 min-w-[160px]">
                    <div className="px-4 py-3 border-b border-gray-50">
                      <p className="text-xs text-gray-400">Вы вошли как</p>
                      <p className="text-sm font-semibold text-[#1D1D1F] truncate">{session.phone}</p>
                    </div>
                    <button
                      onClick={() => { router.push('/profile'); setProfileOpen(false); }}
                      className="flex items-center gap-2 w-full px-4 py-3 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                    >
                      📋 {t.myOrders}
                    </button>
                    <button
                      onClick={() => { logout(); setProfileOpen(false); }}
                      className="flex items-center gap-2 w-full px-4 py-3 text-sm text-red-500 hover:bg-red-50 transition-colors border-t border-gray-50"
                    >
                      🚪 {t.logout}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </header>

      <AuthModal open={authOpen} onClose={() => setAuthOpen(false)} />
    </>
  );
}
