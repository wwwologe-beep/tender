'use client';

import { createContext, useContext, useState, useCallback, ReactNode } from 'react';

export type Lang = 'ru' | 'en' | 'ka';

// ─── Translations ─────────────────────────────────────────────────────────────

export const T: Record<Lang, Record<string, string>> = {
  ru: {
    brand:       'mushebi.ge',
    tagline:     'Любые задачи в Грузии',
    myOrders:    'Мои заказы',
    heroTitle:   'Вы задаёте условия —\nAI находит лучшее решение',
    heroSub:     'Опишите задачу своими словами. Наш AI-диспетчер превратит её в чёткое ТЗ, а исполнители сами предложат цены.',
    placeholder:      '',
    placeholderLabel: 'Что нужно сделать?',
    hintFurniture:    'Рекомендация: укажите размеры мебели и нужно ли её разбирать — это ускорит подбор исполнителей.',
    hintHeavy:        'Рекомендация: укажите этаж, наличие лифта и возможность подъезда к дому.',
    hintCleaning:     'Рекомендация: укажите тип ткани или покрытия, характер загрязнений или площадь помещения.',
    hintDefault:      'Рекомендация: добавьте точный адрес и удобное время — это увеличит качество описания.',
    hintDefaultNoAddr:'Рекомендация: укажите район или адрес — это поможет исполнителям оценить логистику.',
    hintDefaultNoTime:'Рекомендация: укажите удобное время или дату выполнения задачи.',
    scoreLabel:       'Качество описания',
    scoreEmpty:       '',
    scoreWeak:        'Нужно больше деталей',
    scoreGood:        'Хорошее описание',
    scoreGreat:       'Отличное описание',
    scorePerfect:     'Идеально ✨',
    attachLabel: 'Прикрепите фото, смету или документы',
    attachHint:  'до 5 файлов · JPG, PNG, PDF, DOCX',
    phonePlaceholder: '+995 ___ __ __ __',
    phoneLabel:  'Ваш телефон',
    submitBtn:   'Опубликовать задачу →',
    postNote:    'После публикации исполнители получат уведомления и начнут предлагать цены. Вы увидите их в реальном времени на следующей странице.',
    errNoDesc:   'Пожалуйста, опишите вашу задачу.',
    errNoPhone:  'Укажите номер телефона для связи.',
    errNetwork:  'Нет соединения. Проверьте интернет и попробуйте снова.',
    errGeneric:  'Что-то пошло не так. Попробуйте ещё раз.',
    uploading:   'Загружаем медиафайлы...',
    analyzing:   '🤖 ИИ Мушеби анализирует вашу задачу...',
    analyzingSub:'Определяем категорию и распределяем заказ среди профильных мастеров и исполнителей Тбилиси / Батуми.',
    trustSpeed:  '10 минут до первых предложений',
    trustBlind:  '0 звонков',
    trustVet:    'Точная цена без сюрпризов',
    aiReady:     '✨ AI-ассистент готов помочь',
    onlineCount: 'Сейчас в сети: {n} мастеров',
    chips: '🚛 Переезды|🗑 Вывоз мусора|🎹 Перенос пианино|🧹 Клининг|🔧 Мастер на час|🏗 Разнорабочие|📦 Доставка|🛋 Сборка мебели',
    // auth
    authTitle:   'Вход в личный кабинет',
    authSub:     'Введите номер телефона — пришлём код подтверждения.',
    authPhonePlaceholder: '+995 599 000 000',
    authSendCode:'Получить код',
    authCodeLabel:'Код из SMS',
    authCodePlaceholder: '_ _ _ _',
    authVerify:  'Войти',
    authBack:    '← Изменить номер',
    authCodeSent:'Код отправлен на',
    authLoading: 'Отправляем...',
    authVerifying:'Проверяем...',
    // profile
    profileTitle:'Мои заказы',
    tabActive:   'Активные',
    tabArchive:  'Архив',
    emptyActive: 'Нет активных заказов',
    emptyArchive:'История заказов пуста',
    goToFeed:    'Перейти к торгам →',
    logout:      'Выйти',
    newOrder:    '+ Новый заказ',
    statusBidding:   '⏳ Приём ставок',
    statusSelected:  '✅ Исполнитель выбран',
    statusCompleted: '🏁 Завершён',
    statusCancelled: '❌ Отменён',
  },
  en: {
    brand:       'mushebi.ge',
    tagline:     'Any task in Georgia',
    myOrders:    'My orders',
    heroTitle:   'You set the terms —\nAI finds the best solution',
    heroSub:     'Simply describe your task. Our AI assistant will structure it perfectly, and professionals will send their offers directly to you.',
    placeholder:      '',
    placeholderLabel: 'What needs to be done?',
    hintFurniture:    'Recommendation: specify furniture dimensions and whether it needs to be disassembled.',
    hintHeavy:        'Recommendation: specify the floor number, elevator availability and vehicle access to the building.',
    hintCleaning:     'Recommendation: specify fabric or surface type, type of stains or total area.',
    hintDefault:      'Recommendation: add the exact address and preferred time to improve your score.',
    hintDefaultNoAddr:'Recommendation: specify the district or address — this helps contractors plan logistics.',
    hintDefaultNoTime:'Recommendation: specify a convenient date or time for the task.',
    scoreLabel:       'Description quality',
    scoreEmpty:       '',
    scoreWeak:        'Needs more detail',
    scoreGood:        'Good description',
    scoreGreat:       'Great description',
    scorePerfect:     'Perfect ✨',
    attachLabel: 'Attach photos, estimates or documents',
    attachHint:  'up to 5 files · JPG, PNG, PDF, DOCX',
    phonePlaceholder: '+995 ___ __ __ __',
    phoneLabel:  'Your phone',
    submitBtn:   'Publish task →',
    postNote:    'After publishing, contractors will be notified and start making offers. You will see them in real time on the next page.',
    errNoDesc:   'Please describe your task.',
    errNoPhone:  'Please enter your phone number.',
    errNetwork:  'No connection. Check internet and try again.',
    errGeneric:  'Something went wrong. Please try again.',
    uploading:   'Uploading files...',
    analyzing:   '🤖 Mushebi AI is analysing your task...',
    analyzingSub:'Determining category and routing to relevant contractors in Tbilisi / Batumi.',
    trustSpeed:  'Offers in 10 minutes',
    trustBlind:  '0 phone calls',
    trustVet:    'Accurate pricing, no hidden costs',
    aiReady:     '✨ AI assistant is ready to help',
    onlineCount: '{n} masters online now',
    chips: '🚛 Moving|🗑 Junk removal|🎹 Piano moving|🧹 Cleaning|🔧 Handyman|🏗 Day labour|📦 Delivery|🛋 Furniture assembly',
    authTitle:   'Sign in',
    authSub:     'Enter your phone number — we will send a confirmation code.',
    authPhonePlaceholder: '+995 599 000 000',
    authSendCode:'Send code',
    authCodeLabel:'SMS code',
    authCodePlaceholder: '_ _ _ _',
    authVerify:  'Sign in',
    authBack:    '← Change number',
    authCodeSent:'Code sent to',
    authLoading: 'Sending...',
    authVerifying:'Verifying...',
    profileTitle:'My orders',
    tabActive:   'Active',
    tabArchive:  'Archive',
    emptyActive: 'No active orders',
    emptyArchive:'Order history is empty',
    goToFeed:    'View bids →',
    logout:      'Sign out',
    newOrder:    '+ New task',
    statusBidding:   '⏳ Accepting bids',
    statusSelected:  '✅ Contractor selected',
    statusCompleted: '🏁 Completed',
    statusCancelled: '❌ Cancelled',
  },
  ka: {
    brand:       'mushebi.ge',
    tagline:     'ნებისმიერი დავალება საქართველოში',
    myOrders:    'ჩემი შეკვეთები',
    heroTitle:   'თქვენ ადგენთ პირობებს —\nAI პოულობს საუკეთესო გადაწყვეტას',
    heroSub:     'აღწერეთ დავალება თქვენი სიტყვებით. ჩვენი AI-ასისტენტი ავტომატურად დაალაგებს შეკვეთას, ხოლო შემსრულებლები თავად გამოგიგზავნიან წინადადებებს.',
    placeholder:      '',
    placeholderLabel: 'რა გჭირდებათ?',
    hintFurniture:    'რეკომენდაცია: მიუთითეთ ავეჯის ზომები და საჭიროა თუ არა დაშლა.',
    hintHeavy:        'რეკომენდაცია: მიუთითეთ სართული, ლიფტის არსებობა და მანქანის მიახლოების შესაძლებლობა.',
    hintCleaning:     'რეკომენდაცია: მიუთითეთ ქსოვილის ან საფარის ტიპი, დაბინძურების ხასიათი ან ფართობი.',
    hintDefault:      'რეკომენდაცია: დაამატეთ ზუსტი მისამართი და სასურველი დრო — ეს გაზრდის შეფასებას.',
    hintDefaultNoAddr:'რეკომენდაცია: მიუთითეთ უბანი ან მისამართი — ეს დაეხმარება შემსრულებლებს ლოგისტიკის შეფასებაში.',
    hintDefaultNoTime:'რეკომენდაცია: მიუთითეთ სამუშაოს მოსახერხებელი თარიღი ან დრო.',
    scoreLabel:       'აღწერის ხარისხი',
    scoreEmpty:       '',
    scoreWeak:        'საჭიროა მეტი დეტალი',
    scoreGood:        'კარგი აღწერა',
    scoreGreat:       'შესანიშნავი აღწერა',
    scorePerfect:     'იდეალურია ✨',
    attachLabel: 'მიამაგრეთ ფოტო, სმეტა ან დოკუმენტები',
    attachHint:  'მაქსიმუმ 5 ფაილი · JPG, PNG, PDF, DOCX',
    phonePlaceholder: '+995 ___ __ __ __',
    phoneLabel:  'თქვენი ტელეფონი',
    submitBtn:   'დავალების გამოქვეყნება →',
    postNote:    'გამოქვეყნების შემდეგ შემსრულებლები შეტყობინებას მიიღებენ და დაიწყებენ ფასების შეთავაზებას. მათ ნახავთ შემდეგ გვერდზე რეალურ დროში.',
    errNoDesc:   'გთხოვთ, აღწეროთ თქვენი დავალება.',
    errNoPhone:  'მიუთითეთ საკონტაქტო ტელეფონის ნომერი.',
    errNetwork:  'კავშირი არ არის. შეამოწმეთ ინტერნეტი და სცადეთ ხელახლა.',
    errGeneric:  'რაღაც შეცდომა მოხდა. სცადეთ ხელახლა.',
    uploading:   'ფაილების ატვირთვა...',
    analyzing:   '🤖 მუშები AI აანალიზებს თქვენს დავალებას...',
    analyzingSub:'ვადგენთ კატეგორიას და ვანაწილებთ შეკვეთას თბილისის / ბათუმის შემსრულებლებზე.',
    trustSpeed:  '10 წუთი პირველ შეთავაზებამდე',
    trustBlind:  '0 ზარი',
    trustVet:    'ზუსტი ფასი სიურპრიზების გარეშე',
    aiReady:     '✨ AI-ასისტენტი მზადაა დასახმარებლად',
    onlineCount: 'ახლა ონლაინ: {n} ოსტატი',
    chips: '🚛 გადასახლება|🗑 ნარჩენების გატანა|🎹 პიანინოს გადატანა|🧹 დალაგება|🔧 ოსტატი|🏗 მუშახელი|📦 მიწოდება|🛋 ავეჯის აწყობა',
    authTitle:   'პირად კაბინეტში შესვლა',
    authSub:     'შეიყვანეთ ტელეფონის ნომერი — გამოვგზავნით დადასტურების კოდს.',
    authPhonePlaceholder: '+995 599 000 000',
    authSendCode:'კოდის მიღება',
    authCodeLabel:'SMS კოდი',
    authCodePlaceholder: '_ _ _ _',
    authVerify:  'შესვლა',
    authBack:    '← ნომრის შეცვლა',
    authCodeSent:'კოდი გაიგზავნა',
    authLoading: 'გავგზავნით...',
    authVerifying:'ვამოწმებთ...',
    profileTitle:'ჩემი შეკვეთები',
    tabActive:   'აქტიური',
    tabArchive:  'არქივი',
    emptyActive: 'აქტიური შეკვეთები არ არის',
    emptyArchive:'შეკვეთების ისტორია ცარიელია',
    goToFeed:    'ვაჭრობაზე გადასვლა →',
    logout:      'გასვლა',
    newOrder:    '+ ახალი შეკვეთა',
    statusBidding:   '⏳ ვიღებთ შეთავაზებებს',
    statusSelected:  '✅ შემსრულებელი შეირჩა',
    statusCompleted: '🏁 დასრულებული',
    statusCancelled: '❌ გაუქმებული',
  },
} as const;

export type TranslationKey = keyof typeof T['ru'];

// ─── Context ──────────────────────────────────────────────────────────────────

interface I18nCtx {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: Record<string, string>;
}

const I18nContext = createContext<I18nCtx | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>('ru');

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    if (typeof window !== 'undefined') localStorage.setItem('msb_lang', l);
  }, []);

  // restore from localStorage on mount (effect-free approach: checked once at render)
  const t = T[lang];

  return (
    <I18nContext.Provider value={{ lang, setLang, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n(): I18nCtx {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used inside I18nProvider');
  return ctx;
}

/** Type-safe accessor: returns string (falls back to key if missing) */
export function ts(t: Record<string, string | string[]>, key: string): string {
  const v = t[key];
  return typeof v === 'string' ? v : Array.isArray(v) ? v.join('') : key;
}
