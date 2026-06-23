'use client';

import { useState, useEffect, useRef } from 'react';
import { useAuth } from '@/lib/auth-context';
import { useI18n } from '@/lib/i18n';

interface Props {
  open:    boolean;
  onClose: () => void;
}

type Step = 'phone' | 'waiting';

const WAPPI_PHONE = '995599994854';

export function AuthModal({ open, onClose }: Props) {
  const { login }   = useAuth();
  const { t, lang } = useI18n();

  const [step,    setStep]    = useState<Step>('phone');
  const [phone,   setPhone]   = useState('');
  const [code,    setCode]    = useState('');
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);

  const pollRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!open) {
      setTimeout(() => {
        setStep('phone');
        setPhone('');
        setCode('');
        setError(null);
        setSeconds(0);
        stopPolling();
      }, 300);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  function stopPolling() {
    if (pollRef.current)  clearInterval(pollRef.current);
    if (timerRef.current) clearInterval(timerRef.current);
    pollRef.current  = null;
    timerRef.current = null;
  }

  async function handleStart() {
    const p = phone.trim();
    if (!p) { setError(t.errNoPhone); return; }
    setLoading(true);
    setError(null);
    try {
      const res  = await fetch('/api/auth/send-otp', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ phone: p }),
      });
      const data = await res.json() as { ok?: boolean; code?: string; error?: string };
      if (!res.ok || !data.code) { setError(data.error ?? t.errGeneric); return; }
      setCode(data.code);
      setStep('waiting');
      setSeconds(0);
      startPolling(p);
    } catch {
      setError(t.errNetwork);
    } finally {
      setLoading(false);
    }
  }

  function startPolling(p: string) {
    timerRef.current = setInterval(() => setSeconds(s => s + 1), 1000);
    pollRef.current  = setInterval(async () => {
      try {
        const res  = await fetch(`/api/auth/check-whatsapp?phone=${encodeURIComponent(p)}`);
        const data = await res.json() as { ready?: boolean; token?: string; phone?: string };
        if (data.ready && data.token) {
          stopPolling();
          login(data.phone!, data.token);
          onClose();
        }
      } catch { /* silent */ }
    }, 2500);
  }

  function openWhatsApp() {
    window.open(`https://wa.me/${WAPPI_PHONE}?text=${encodeURIComponent(code)}`, '_blank');
  }

  const L = {
    ru: {
      title:     'Вход через WhatsApp',
      sub:       'Введите ваш номер телефона',
      btn:       'Продолжить →',
      waitTitle: 'Отправьте нам сообщение',
      waitSub:   'Нажмите кнопку — WhatsApp откроется с готовым кодом. Просто отправьте его нам.',
      waBtn:     '💬 Отправить код в WhatsApp',
      change:    '← Изменить номер',
      copyHint:  'Ваш код для входа:',
      timer:     (s: number) => `Ожидаем подтверждения · ${s}с`,
    },
    en: {
      title:     'Sign in via WhatsApp',
      sub:       'Enter your phone number',
      btn:       'Continue →',
      waitTitle: 'Send us a message',
      waitSub:   'Tap the button — WhatsApp will open with your code ready. Just send it.',
      waBtn:     '💬 Send code via WhatsApp',
      change:    '← Change number',
      copyHint:  'Your login code:',
      timer:     (s: number) => `Waiting for confirmation · ${s}s`,
    },
    ka: {
      title:     'შესვლა WhatsApp-ით',
      sub:       'შეიყვანეთ ტელეფონის ნომერი',
      btn:       'გაგრძელება →',
      waitTitle: 'გამოგვიგზავნეთ შეტყობინება',
      waitSub:   'დააჭირეთ ღილაკს — WhatsApp გაიხსნება მზა კოდით. უბრალოდ გამოაგზავნეთ.',
      waBtn:     '💬 კოდის WhatsApp-ით გაგზავნა',
      change:    '← ნომრის შეცვლა',
      copyHint:  'თქვენი შესვლის კოდი:',
      timer:     (s: number) => `ველოდებით დადასტურებას · ${s}წ`,
    },
  }[lang] ?? {
    title: 'Sign in via WhatsApp', sub: 'Enter your phone number', btn: 'Continue →',
    waitTitle: 'Send us a message', waitSub: 'Tap the button to open WhatsApp with your code.',
    waBtn: '💬 Send code via WhatsApp', change: '← Change number', copyHint: 'Your login code:',
    timer: (s: number) => `Waiting · ${s}s`,
  };

  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40" onClick={onClose} />

      <div className="fixed inset-x-0 bottom-0 z-50 flex flex-col items-center sm:inset-0 sm:justify-center pointer-events-none">
        <div className="pointer-events-auto w-full max-w-sm bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl px-6 pt-8 pb-10 mx-auto">

          <div className="w-10 h-1 bg-gray-200 rounded-full mx-auto mb-6 sm:hidden" />

          {/* ── STEP: phone ── */}
          {step === 'phone' && (
            <>
              <div className="mb-6 text-center">
                <div className="w-14 h-14 bg-[#25D366]/10 rounded-2xl flex items-center justify-center text-3xl mx-auto mb-4">
                  💬
                </div>
                <h2 className="text-xl font-bold text-[#1D1D1F]">{L.title}</h2>
                <p className="text-sm text-gray-500 mt-1">{L.sub}</p>
              </div>
              <div className="space-y-4">
                <input
                  type="tel"
                  inputMode="tel"
                  placeholder="+995 599 000 000"
                  value={phone}
                  onChange={e => { setPhone(e.target.value); setError(null); }}
                  onKeyDown={e => e.key === 'Enter' && handleStart()}
                  className="w-full px-4 py-3.5 rounded-2xl border border-gray-200 bg-gray-50 text-[#1D1D1F] text-base placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-[#25D366]/30 focus:border-[#25D366] transition-all"
                  autoFocus
                />
                {error && <p className="text-red-500 text-sm text-center">{error}</p>}
                <button
                  onClick={handleStart}
                  disabled={loading}
                  className={[
                    'w-full py-4 rounded-2xl text-base font-semibold transition-all',
                    loading
                      ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                      : 'bg-[#25D366] hover:bg-[#1ebe5d] active:scale-[0.98] text-white shadow-sm',
                  ].join(' ')}
                >
                  {loading ? '...' : L.btn}
                </button>
              </div>
            </>
          )}

          {/* ── STEP: waiting ── */}
          {step === 'waiting' && (
            <>
              <div className="mb-5 text-center">
                <div className="w-14 h-14 bg-[#25D366]/10 rounded-2xl flex items-center justify-center text-3xl mx-auto mb-4">
                  📲
                </div>
                <h2 className="text-xl font-bold text-[#1D1D1F]">{L.waitTitle}</h2>
                <p className="text-sm text-gray-500 mt-1.5 leading-relaxed">{L.waitSub}</p>
              </div>

              {/* Code box */}
              <div className="bg-gray-50 border border-dashed border-gray-300 rounded-2xl p-4 mb-5 text-center">
                <p className="text-[11px] text-gray-400 uppercase tracking-wide mb-1.5">{L.copyHint}</p>
                <p className="text-2xl font-mono font-bold text-[#1D1D1F] tracking-widest select-all">{code}</p>
              </div>

              {/* WhatsApp CTA */}
              <button
                onClick={openWhatsApp}
                className="w-full py-4 rounded-2xl text-base font-semibold bg-[#25D366] hover:bg-[#1ebe5d] active:scale-[0.98] text-white shadow-sm transition-all mb-4"
              >
                {L.waBtn}
              </button>

              {/* Pulse indicator */}
              <div className="flex items-center justify-center gap-2 text-xs text-gray-400 mb-4">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#25D366] opacity-60" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-[#25D366]" />
                </span>
                {L.timer(seconds)}
              </div>

              <button
                onClick={() => { stopPolling(); setStep('phone'); setCode(''); }}
                className="w-full text-sm text-gray-400 hover:text-gray-600 transition-colors text-center py-1"
              >
                {L.change}
              </button>
            </>
          )}
        </div>
      </div>
    </>
  );
}
