'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { Navbar } from '@/components/Navbar';
import { useI18n, Lang } from '@/lib/i18n';

// ─── Types ────────────────────────────────────────────────────────────────────

interface AttachedFile {
  file:    File;
  preview: string | null;
}

type LoaderPhase = 'idle' | 'uploading' | 'analyzing' | 'done';

// Единственный контракт состояния формы, который потребляет UI
export interface TenderStatus {
  status:      'empty' | 'incomplete' | 'ready';
  score:       number;        // 0 | 40 | 100
  message:     string | null; // текст AI-совета (null = нет совета / ещё загружается)
  refinedText: string | null; // структурированный черновик от AI
  loading:     boolean;       // AI запрос в процессе
}

const MAX_FILES = 5;
const BUCKET    = 'tender_media';

// ─── Dynamic placeholder examples ────────────────────────────────────────────

const EXAMPLES: Record<Lang, string[]> = {
  ru: [
    'Перевезти диван с Сабуртало на Ваке завтра к 12:00',
    'Вывезти 30 мешков строительного мусора, 4 этаж без лифта, Глдани',
    'Химчистка углового дивана (светлая ткань, пятна от кофе) на дому, Батуми',
    'Переезд: 15 коробок, матрас и велосипед. С Вера на Дидубе в субботу',
    'Два грузчика — перенести пианино внутри квартиры, Чугурети, 2 этаж',
    'Генеральная уборка 2-комнатной квартиры после съезда жильцов, 60 кв.м.',
    'Повесить 3 люстры, закрепить карниз в спальне и починить розетку в ванной',
    'Спустить старый холодильник с 5 этажа (без лифта), поставить у мусорки, Батуми',
    'Собрать кухню IKEA: 12 модулей + вытяжка, частный дом, Нуцубидзе',
    'Доставить стиральную машину из магазина на Руставели домой в Варкетили, 7 этаж',
  ],
  en: [
    'Move a sofa from Saburtalo to Vake tomorrow by 12:00',
    'Remove 30 bags of construction waste, 4th floor, no elevator, Gldani',
    'Dry-clean an L-shaped sofa at home, light fabric, coffee stains, Batumi',
    'Apartment move: 15 boxes, mattress and bike. From Vera to Didube on Saturday',
    'Two movers to carry a piano within the apartment, 2nd floor, Chugureti',
    'Deep clean of 2-bedroom apartment after tenants moved out, 60 sqm',
    'Hang 3 chandeliers, fix curtain rod in bedroom and repair outlet in bathroom',
    'Carry old fridge down from 5th floor (no elevator), place near dumpster, Batumi',
    'Assemble IKEA kitchen: 12 modules + extractor fan, private house, Nutsubidze',
    'Deliver washing machine from store on Rustaveli to apartment in Varketili, 7th floor',
  ],
  ka: [
    'დივნის გადატანა საბურთალოდან ვაკეში ხვალ 12:00 საათისთვის',
    '30 ტომარა სამშენებლო ნაგვის გატანა, მე-4 სართული ლიფტის გარეშე, გლდანი',
    'კუთხის დივნის ქიმწმენდა ბინაზე მოსვლით, ღია ქსოვილი, ბათუმი',
    'გადასახლება: 15 კოლოფი, მატრასი და ველოსიპედი. ვერადან დიდუბეში შაბათს',
    'ორი მტვირთველი — პიანინოს გადატანა ბინის ფარგლებში, ჩუღურეთი, მე-2 სართული',
    'გენერალური დასუფთავება 2-ოთახიანი ბინისა, 60 კვ.მ., ქირავნობის შემდეგ',
    '3 ჭაღის გამოკიდება, კარნიზის დამაგრება და სააბაზანოში ელსიგნალის შეკეთება',
    'ძველი მაცივრის ჩამოტანა მე-5 სართულიდან (ლიფტი არ არის), ნაგვის ყუთთან, ბათუმი',
    'IKEA სამზარეულოს აწყობა: 12 მოდული + გამწოვი, კერძო სახლი, ნუცუბიძე',
    'სარეცხი მანქანის მიტანა მაღაზიიდან რუსთაველზე — ვარკეთილი, მე-7 სართული',
  ],
};

// ─── Fallback regex score (заглушка пока AI не ответил) ──────────────────────
// Возвращает 0 | 40 | 100 — только для начального отображения шкалы.
// После ответа AI этот результат заменяется бинарным AI-значением.

function quickRegexScore(text: string): 0 | 40 | 100 {
  const t = text.toLowerCase().trim();
  if (t.length < 10) return 0;

  const hasTask     = t.length >= 25;
  const hasLocation = /ваке|сабуртало|глдани|дидубе|батуми|тбилиси|район|vake|saburtalo|gldani|batumi|tbilisi|ვაკე|საბურთალო|გლდანი|ბათუმი|თბილის/.test(t);
  const hasTime     = /завтра|сегодня|утр|вечер|tomorrow|today|morning|evening|\d{1,2}:\d{2}|ხვალ|დღეს|დილ|საღამო/.test(t);

  if (hasTask && hasLocation && hasTime) return 100;
  if (hasTask) return 40;
  return 0;
}

// ─── useTenderStatus ──────────────────────────────────────────────────────────
// Единый хук состояния формы. UI потребляет только TenderStatus.

interface AiCacheEntry {
  hint:         string | null;
  refined_text: string | null;
}

function useTenderStatus(text: string, lang: string, isTyping: boolean): TenderStatus {
  const [aiResult,      setAiResult]      = useState<'ready' | 'incomplete' | null>(null);
  const [aiMessage,     setAiMessage]     = useState<string | null>(null);
  const [aiRefinedText, setAiRefinedText] = useState<string | null>(null);
  const [aiLoading,     setAiLoading]     = useState(false);
  const [aiVisible,     setAiVisible]     = useState(false);

  const cache    = useRef<Map<string, AiCacheEntry>>(new Map());
  const timer    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevText = useRef('');

  useEffect(() => {
    if (isTyping) {
      setAiVisible(false);
      if (timer.current) clearTimeout(timer.current);
    }
  }, [isTyping]);

  useEffect(() => {
    if (isTyping) return;

    const trimmed = text.trim();

    if (trimmed.length < 10) {
      setAiResult(null);
      setAiMessage(null);
      setAiRefinedText(null);
      setAiVisible(false);
      return;
    }

    if (trimmed === prevText.current) return;

    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      prevText.current = trimmed;

      if (cache.current.has(trimmed)) {
        applyAiResponse(cache.current.get(trimmed)!);
        return;
      }

      setAiLoading(true);
      try {
        const res  = await fetch('/api/analyze-order', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ text: trimmed, lang }),
        });
        const data = await res.json() as AiCacheEntry;
        const entry: AiCacheEntry = { hint: data.hint ?? null, refined_text: data.refined_text ?? null };
        cache.current.set(trimmed, entry);
        applyAiResponse(entry);
      } catch {
        // Сетевая ошибка — не блокируем UX
      } finally {
        setAiLoading(false);
      }
    }, 2000);

    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [text, lang, isTyping]); // eslint-disable-line react-hooks/exhaustive-deps

  function applyAiResponse(entry: AiCacheEntry) {
    const isReady = !entry.hint || /^(отлично|perfect|შესანიშნავია)!?$/i.test(entry.hint.trim());
    setAiResult(isReady ? 'ready' : 'incomplete');
    setAiMessage(isReady ? null : entry.hint);
    setAiRefinedText(entry.refined_text);
    if (!isReady && entry.hint) {
      requestAnimationFrame(() => requestAnimationFrame(() => setAiVisible(true)));
    }
  }

  const trimmed = text.trim();

  if (trimmed.length < 10) {
    return { status: 'empty', score: 0, message: null, refinedText: null, loading: false };
  }

  if (aiResult === null) {
    return {
      status:      'incomplete',
      score:       quickRegexScore(trimmed),
      message:     null,
      refinedText: null,
      loading:     aiLoading,
    };
  }

  return {
    status:      aiResult,
    score:       aiResult === 'ready' ? 100 : 40,
    message:     aiVisible && !isTyping ? aiMessage : null,
    refinedText: aiVisible && !isTyping ? aiRefinedText : null,
    loading:     aiLoading,
  };
}

// ─── useOnlineCount ───────────────────────────────────────────────────────────
// Имитирует "живой" счётчик мастеров: стартует с реалистичного числа,
// каждые 8-14с случайно ±1. Не делает сетевых запросов.

function useOnlineCount() {
  const [count, setCount] = useState(() => 38 + Math.floor(Math.random() * 12));
  useEffect(() => {
    const tick = () => {
      setCount(n => Math.max(28, Math.min(60, n + (Math.random() > 0.5 ? 1 : -1))));
      timer = setTimeout(tick, 8000 + Math.random() * 6000);
    };
    let timer = setTimeout(tick, 8000 + Math.random() * 6000);
    return () => clearTimeout(timer);
  }, []);
  return count;
}

// ─── useFadingPlaceholder ─────────────────────────────────────────────────────

function useFadingPlaceholder(lang: Lang, active: boolean) {
  const [idx,     setIdx]     = useState(0);
  const [visible, setVisible] = useState(true);
  const examples = EXAMPLES[lang];

  useEffect(() => { setIdx(0); setVisible(true); }, [lang]);

  useEffect(() => {
    if (!active) return;
    const iv = setInterval(() => {
      setVisible(false);
      const swap = setTimeout(() => { setIdx(i => (i + 1) % examples.length); setVisible(true); }, 450);
      return () => clearTimeout(swap);
    }, 4500);
    return () => clearInterval(iv);
  }, [active, examples.length]);

  return { text: examples[idx], visible };
}

// ─── ConfirmModal ─────────────────────────────────────────────────────────────

function ConfirmModal({
  message,
  onConfirm,
  onCancel,
  lang,
}: {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  lang: Lang;
}) {
  const labels = {
    ru: { title: 'Заказ может не получить откликов', detail: 'Исполнители не смогут рассчитать цену без недостающих данных:', cancel: 'Дополнить описание', confirm: 'Всё равно опубликовать' },
    en: { title: 'Order may not receive responses', detail: 'Contractors need more information to price the job:', cancel: 'Improve description', confirm: 'Publish anyway' },
    ka: { title: 'შეკვეთა შეიძლება პასუხი არ მიიღოს', detail: 'შემსრულებლებს ფასის დასახელებისთვის მეტი ინფორმაცია სჭირდებათ:', cancel: 'აღწერის გაუმჯობესება', confirm: 'მაინც გამოქვეყნება' },
  }[lang];

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center px-4 pb-6 sm:pb-0">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative bg-white rounded-3xl shadow-2xl max-w-sm w-full p-6 z-10">
        <div className="text-2xl mb-3">⚠️</div>
        <h3 className="text-base font-semibold text-[#1D1D1F] mb-2">{labels.title}</h3>
        <p className="text-sm text-gray-500 mb-2">{labels.detail}</p>
        <p className="text-sm text-gray-700 bg-amber-50 border border-amber-100 rounded-xl px-3.5 py-2.5 mb-5">
          {message}
        </p>
        <div className="flex flex-col gap-2">
          <button
            onClick={onCancel}
            className="w-full py-3 rounded-2xl bg-[#1D1D1F] text-white text-sm font-semibold hover:bg-[#333] transition-colors"
          >
            {labels.cancel}
          </button>
          <button
            onClick={onConfirm}
            className="w-full py-3 rounded-2xl border border-gray-200 text-gray-500 text-sm hover:bg-gray-50 transition-colors"
          >
            {labels.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function HomePage() {
  const router      = useRouter();
  const { t, lang } = useI18n();

  const [description,   setDescription]   = useState('');
  const [phone,         setPhone]         = useState('');
  const [files,         setFiles]         = useState<AttachedFile[]>([]);
  const [dragging,      setDragging]      = useState(false);
  const [phase,         setPhase]         = useState<LoaderPhase>('idle');
  const [error,         setError]         = useState<string | null>(null);
  const [focused,       setFocused]       = useState(false);
  const [isTyping,      setIsTyping]      = useState(false);
  const [confirmPending,  setConfirmPending]  = useState(false);
  const [applyFlash, setApplyFlash] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const typingTimer  = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Единый источник истины о состоянии заказа
  const tender      = useTenderStatus(description, lang, isTyping);
  const onlineCount = useOnlineCount();

  // Placeholder только пока поле пустое и не в фокусе
  const placeholderActive = !focused && description.trim().length === 0;
  const { text: exampleText, visible: exampleVisible } = useFadingPlaceholder(lang, placeholderActive);

  // ── Score bar helpers ────────────────────────────────────────────────────────

  function barColor(score: number): string {
    if (score === 0)   return 'bg-gray-200';
    if (score <= 40)   return 'bg-amber-400';
    return 'bg-emerald-500';
  }

  function scoreTextColor(score: number): string {
    if (score === 0)   return 'text-gray-300';
    if (score <= 40)   return 'text-amber-500';
    return 'text-emerald-500';
  }

  function scoreLabel(score: number): string {
    if (score === 0)   return t.scoreEmpty   ?? '';
    if (score <= 40)   return t.scoreWeak    ?? '';
    return t.scorePerfect ?? '';
  }

  // ── File helpers ─────────────────────────────────────────────────────────────

  function addFiles(raw: FileList | File[]) {
    const incoming = Array.from(raw);
    setFiles(prev => {
      const slots = MAX_FILES - prev.length;
      if (slots <= 0) return prev;
      return [
        ...prev,
        ...incoming.slice(0, slots).map(file => ({
          file,
          preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
        })),
      ];
    });
    if (error) setError(null);
  }

  function removeFile(idx: number) {
    setFiles(prev => {
      const f = prev[idx];
      if (f?.preview) URL.revokeObjectURL(f.preview);
      return prev.filter((_, i) => i !== idx);
    });
  }

  // ── Drag-and-drop ────────────────────────────────────────────────────────────

  const onDragOver  = useCallback((e: React.DragEvent) => { e.preventDefault(); setDragging(true); }, []);
  const onDragLeave = useCallback(() => setDragging(false), []);
  const onDrop      = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragging(false);
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Upload ───────────────────────────────────────────────────────────────────

  async function uploadFiles(): Promise<string[]> {
    const folder = crypto.randomUUID();
    const urls: string[] = [];
    for (const { file } of files) {
      const ext  = file.name.split('.').pop() ?? 'bin';
      const path = `tmp/${folder}/${crypto.randomUUID()}.${ext}`;
      const { error: upErr } = await supabaseBrowser.storage
        .from(BUCKET).upload(path, file, { upsert: false });
      if (upErr) { console.error('[upload]', upErr.message); continue; }
      const { data } = supabaseBrowser.storage.from(BUCKET).getPublicUrl(path);
      if (data?.publicUrl) urls.push(data.publicUrl);
    }
    return urls;
  }

  // ── Submit с защитой "сырого" заказа ─────────────────────────────────────────

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!description.trim()) { setError(t.errNoDesc);  return; }
    if (!phone.trim())        { setError(t.errNoPhone); return; }
    setError(null);

    // Если AI-хинт активен — показываем confirmation modal
    if (tender.status === 'incomplete' && tender.message) {
      setConfirmPending(true);
      return;
    }

    await doSubmit();
  }

  function applyRefinedText() {
    if (!tender.refinedText) return;
    setDescription(tender.refinedText);
    setApplyFlash(true);
    setTimeout(() => setApplyFlash(false), 400);
  }

  async function doSubmit() {
    let mediaUrls: string[] = [];
    if (files.length) {
      setPhase('uploading');
      mediaUrls = await uploadFiles();
    }
    setPhase('analyzing');

    try {
      const res  = await fetch('/api/tender/create', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cargo_description: description.trim(),
          client_phone:      phone.trim(),
          media_urls:        mediaUrls.length ? mediaUrls : undefined,
          structured:        true,
        }),
      });
      const data = await res.json() as { order?: { token: string }; error?: string; message?: string };
      if (!res.ok || !data.order?.token) {
        setPhase('idle');
        setError(data.message ?? data.error ?? t.errGeneric);
        return;
      }
      setPhase('done');
      router.push(`/feed/${data.order.token}`);
    } catch {
      setPhase('idle');
      setError(t.errNetwork);
    }
  }

  // ── Loader ────────────────────────────────────────────────────────────────────

  if (phase !== 'idle') {
    return (
      <div className="fixed inset-0 bg-[#F6F6F6] flex flex-col items-center justify-center z-50 px-6 text-center">
        <div className="mb-8">
          <div className="inline-block w-14 h-14 rounded-full border-4 border-[#1D1D1F]/10 border-t-[#1D1D1F] animate-spin" />
        </div>
        <p className="text-xl font-semibold text-[#1D1D1F] mb-3">
          {phase === 'uploading' ? t.uploading : t.analyzing}
        </p>
        {phase === 'analyzing' && (
          <p className="text-gray-500 text-sm leading-relaxed max-w-xs">{t.analyzingSub}</p>
        )}
      </div>
    );
  }

  // ── Main UI ───────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-[#F6F6F6] flex flex-col">
      <Navbar />

      {/* Hero */}
      <div className="max-w-2xl mx-auto w-full px-5 pt-10 pb-6 text-center">
        <h1 className="text-[1.9rem] sm:text-[2.5rem] font-bold tracking-tight text-[#1D1D1F] leading-[1.15]">
          {t.heroTitle}
        </h1>
        <p className="mt-3 text-gray-500 text-[0.95rem] sm:text-base leading-relaxed max-w-md mx-auto">
          {t.heroSub}
        </p>
      </div>

      {/* Form */}
      <main className="max-w-2xl mx-auto w-full px-5 pb-20 flex-1">
        <form onSubmit={handleSubmit} className="space-y-3">

          {/* ── Main card ── */}
          <div className={[
            'bg-white rounded-3xl overflow-hidden transition-all duration-300',
            focused
              ? 'shadow-[0_0_0_3px_rgba(29,29,31,0.08),0_4px_24px_rgba(29,29,31,0.10)]'
              : 'shadow-sm',
          ].join(' ')}>

            {/* AI-бейдж над полем */}
            <div className="px-6 pt-4 pb-0 flex items-center gap-1.5">
              <span className="text-[11px]">✨</span>
              <span className="text-[11px] font-medium text-gray-400">{t.aiReady}</span>
            </div>

            {/* Textarea + fading placeholder */}
            <div className="relative">
              <textarea
                rows={6}
                value={description}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                onChange={e => {
                  setDescription(e.target.value);
                  if (error) setError(null);
                  setIsTyping(true);
                  if (typingTimer.current) clearTimeout(typingTimer.current);
                  typingTimer.current = setTimeout(() => setIsTyping(false), 300);
                }}
                className={[
                  'w-full px-6 py-4 text-[#1D1D1F] text-base resize-none focus:outline-none bg-transparent relative z-10',
                  'transition-colors duration-300',
                  applyFlash ? 'bg-emerald-50' : '',
                ].join(' ')}
              />

              {/* Animated placeholder overlay */}
              {placeholderActive && (
                <div
                  aria-hidden
                  className={[
                    'pointer-events-none absolute inset-0 px-6 py-4 transition-opacity duration-500 select-none',
                    exampleVisible ? 'opacity-100' : 'opacity-0',
                  ].join(' ')}
                >
                  <p className="text-gray-300 text-sm leading-snug">{exampleText}</p>
                </div>
              )}
            </div>

            {/* ── Score bar + AI hint — видны как только что-то напечатано ── */}
            {tender.status !== 'empty' && (
              <div className="px-5 pb-4 animate-[fadeSlideIn_0.3s_ease_both]">

                {/* Label row */}
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[11px] text-gray-400 font-medium tracking-wide uppercase">
                    {t.scoreLabel}
                  </span>
                  <span className={`text-[11px] font-semibold transition-colors duration-500 ${scoreTextColor(tender.score)}`}>
                    {tender.score}% · {scoreLabel(tender.score)}
                  </span>
                </div>

                {/* Progress bar */}
                <div className="h-1 w-full bg-gray-100 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-700 ${barColor(tender.score)}`}
                    style={{ width: `${tender.score}%` }}
                  />
                </div>

                {/* AI загружается — скелет */}
                {tender.loading && !tender.message && (
                  <div className="mt-3 h-14 rounded-2xl bg-gray-100 animate-pulse" />
                )}

                {/* AI совет — Actionable блок */}
                {tender.message && (
                  <div className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 overflow-hidden">

                    {/* Заголовок с советом */}
                    <div className="px-4 pt-3 pb-2.5 flex items-start gap-2.5">
                      <span className="text-base mt-0.5 shrink-0">💡</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-[11px] font-semibold text-amber-700 mb-0.5 uppercase tracking-wide">
                          {lang === 'ru' ? 'Нужно уточнить для расчёта цены'
                            : lang === 'en' ? 'Required to price the job'
                            : 'საჭიროა ფასის გამოსათვლელად'}
                        </p>
                        <p className="text-[12px] text-amber-800 leading-relaxed">
                          {tender.message}
                        </p>
                      </div>
                    </div>

                    {/* Превью — всегда видно сразу когда AI вернул refined_text */}
                    {tender.refinedText && (
                      <div className="border-t border-amber-200">
                        <div className="px-4 py-3 bg-white/60">
                          <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">
                            {lang === 'ru' ? 'Предпросмотр структуры'
                              : lang === 'en' ? 'Structure preview'
                              : 'სტრუქტურის გადახედვა'}
                          </p>
                          <pre className="text-[12px] text-[#1D1D1F] leading-relaxed whitespace-pre-wrap font-sans">
                            {tender.refinedText}
                          </pre>
                        </div>
                        <div className="px-3 py-2.5 bg-white/40">
                          <button
                            type="button"
                            onClick={applyRefinedText}
                            className="w-full flex items-center justify-center gap-1.5 py-2 rounded-xl bg-[#1D1D1F] hover:bg-[#333] text-white text-[12px] font-semibold transition-all active:scale-[0.98]"
                          >
                            ✨ {lang === 'ru' ? 'Применить структуру'
                                : lang === 'en' ? 'Apply structure'
                                : 'სტრუქტურის გამოყენება'}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Divider */}
            <div className="mx-5 border-t border-gray-100" />

            {/* Drop zone */}
            <div
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
              onClick={() => fileInputRef.current?.click()}
              className={[
                'mx-4 my-4 border-2 border-dashed rounded-2xl px-4 py-3 flex items-center gap-3 cursor-pointer transition-all select-none',
                dragging
                  ? 'border-[#1D1D1F] bg-gray-50'
                  : 'border-gray-200 hover:border-gray-400 hover:bg-gray-50',
              ].join(' ')}
            >
              <span className="text-2xl">📎</span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-600">{t.attachLabel}</p>
                <p className="text-xs text-gray-400">{t.attachHint}</p>
              </div>
              {files.length > 0 && (
                <span className="text-xs font-semibold text-[#1D1D1F] bg-gray-100 rounded-full px-2.5 py-0.5">
                  {files.length}/{MAX_FILES}
                </span>
              )}
            </div>

            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,.pdf,.doc,.docx,.xls,.xlsx"
              className="hidden"
              onChange={e => e.target.files && addFiles(e.target.files)}
            />

            {/* File previews */}
            {files.length > 0 && (
              <div className="flex gap-2 flex-wrap px-4 pb-4">
                {files.map((f, i) => (
                  <div key={i} className="relative group">
                    {f.preview ? (
                      <img src={f.preview} alt={f.file.name}
                        className="w-16 h-16 object-cover rounded-xl border border-gray-100" />
                    ) : (
                      <div className="w-16 h-16 rounded-xl border border-gray-200 bg-gray-50 flex flex-col items-center justify-center gap-1">
                        <span className="text-xl">📄</span>
                        <span className="text-[10px] text-gray-400 truncate w-12 text-center">
                          {f.file.name.split('.').pop()?.toUpperCase()}
                        </span>
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={ev => { ev.stopPropagation(); removeFile(i); }}
                      className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-[#1D1D1F] text-white rounded-full text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                    >×</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Phone */}
          <div>
            <label className="block text-xs text-gray-400 font-medium mb-1.5 pl-1">
              {t.phoneLabel}
            </label>
            <div className="bg-white rounded-3xl shadow-sm overflow-hidden flex items-center">
              <span className="pl-5 text-gray-400 text-base select-none">📞</span>
              <input
                type="tel"
                inputMode="tel"
                placeholder={t.phonePlaceholder}
                value={phone}
                onChange={e => { setPhone(e.target.value); if (error) setError(null); }}
                className="flex-1 px-3 py-4 text-[#1D1D1F] text-base placeholder-gray-400 focus:outline-none"
              />
            </div>
          </div>

          {/* Error */}
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-2xl px-5 py-3 text-red-600 text-sm">
              {error}
            </div>
          )}

          {/* Submit — зеленеет когда AI подтвердил "Отлично!" */}
          <button
            type="submit"
            className={[
              'w-full py-4 rounded-2xl text-white text-base font-semibold shadow-sm transition-all duration-500 active:scale-[0.98]',
              'flex items-center justify-center gap-2 group',
              tender.status === 'ready'
                ? 'bg-emerald-500 hover:bg-emerald-600'
                : 'bg-[#1D1D1F] hover:bg-[#333]',
            ].join(' ')}
          >
            <span>{t.submitBtn}</span>
            <span className="transition-transform duration-200 group-hover:translate-x-1">→</span>
          </button>

          <p className="text-center text-xs text-gray-400 leading-relaxed px-4">{t.postNote}</p>
        </form>

        {/* Trust row */}
        <div className="mt-6 grid grid-cols-3 gap-3 text-center">
          {[
            { icon: '⚡', text: t.trustSpeed },
            { icon: '📵', text: t.trustBlind },
            { icon: '💰', text: t.trustVet },
          ].map(b => (
            <div key={b.text} className="bg-white rounded-2xl p-3 shadow-sm">
              <div className="text-xl mb-1">{b.icon}</div>
              <p className="text-xs text-gray-500 leading-tight">{b.text}</p>
            </div>
          ))}
        </div>

        {/* Социальное доказательство — живой счётчик */}
        <div className="mt-3 flex items-center justify-center gap-1.5">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
          </span>
          <p className="text-[11px] text-gray-400">
            {(t.onlineCount ?? '').replace('{n}', String(onlineCount))}
          </p>
        </div>
      </main>

      {/* Confirm modal — при "сыром" заказе */}
      {confirmPending && tender.message && (
        <ConfirmModal
          message={tender.message}
          lang={lang}
          onCancel={() => setConfirmPending(false)}
          onConfirm={() => { setConfirmPending(false); doSubmit(); }}
        />
      )}
    </div>
  );
}
