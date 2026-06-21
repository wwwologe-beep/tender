import OpenAI from 'openai';
import { supabaseAdmin } from '@/lib/supabase';

// ─── OpenRouter client ────────────────────────────────────────────────────────

function getClient() {
  return new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY ?? '',
    defaultHeaders: {
      'HTTP-Referer': 'https://mushebi.ge',
      'X-Title': 'mushebi.ge advisor',
    },
  });
}

// ─── Типы ────────────────────────────────────────────────────────────────────

export type AdvisorRole = 'driver' | 'client';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// ─── Сбор контекста заказа из базы ──────────────────────────────────────────

async function buildOrderContext(orderId: string, role: AdvisorRole, driverLang = 'ru'): Promise<string> {
  const [orderRes, bidsRes, questionsRes, marketRes] = await Promise.all([
    supabaseAdmin
      .from('tender_orders')
      .select('cargo_description, live_brief_ai, category, status, created_at, scheduled_at, notes')
      .eq('id', orderId)
      .single(),

    supabaseAdmin
      .from('tender_bids')
      .select('amount, status')
      .eq('order_id', orderId)
      .gt('amount', 0)
      .neq('status', 'withdrawn'),

    supabaseAdmin
      .from('order_questions')
      .select('question_original, answer_original, status, answered_by')
      .eq('order_id', orderId)
      .order('created_at', { ascending: true }),

    // Средняя цена по категории за последние 30 дней
    supabaseAdmin
      .from('tender_orders')
      .select('id')
      .eq('status', 'selected')
      .gte('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()),
  ]);

  const order = orderRes.data;
  const bids = bidsRes.data ?? [];
  const questions = questionsRes.data ?? [];

  const bidAmounts = bids.map(b => b.amount).filter(a => a > 0);
  const minBid = bidAmounts.length ? Math.min(...bidAmounts) : null;
  const maxBid = bidAmounts.length ? Math.max(...bidAmounts) : null;
  const avgBid = bidAmounts.length ? Math.round(bidAmounts.reduce((a, b) => a + b, 0) / bidAmounts.length) : null;

  const answeredQ = questions.filter(q => q.answer_original);
  const pendingQ = questions.filter(q => !q.answer_original);

  const lang = driverLang;
  const contextHeader = lang === 'ka'
    ? 'შეკვეთის კონტექსტი'
    : lang === 'en'
    ? 'Order context'
    : 'Контекст заказа';

  let ctx = `=== ${contextHeader} ===\n`;
  ctx += `Описание: ${order?.live_brief_ai ?? order?.cargo_description ?? 'не указано'}\n`;

  if (order?.scheduled_at) {
    ctx += `Дата: ${new Date(order.scheduled_at).toLocaleString('ru-RU', { timeZone: 'Asia/Tbilisi' })}\n`;
  }
  if (order?.notes) ctx += `Примечания: ${order.notes}\n`;
  ctx += `Статус: ${order?.status}\n\n`;

  ctx += `=== Рыночная картина ===\n`;
  ctx += `Ставок подано: ${bidAmounts.length}\n`;
  if (bidAmounts.length > 0) {
    ctx += `Диапазон: ${minBid}–${maxBid} ₾ (среднее ${avgBid} ₾)\n`;
    if (role === 'driver') {
      ctx += `[исполнитель НЕ видит чужие ставки — ты видишь только статистику]\n`;
    }
  } else {
    ctx += `Ставок пока нет — ты можешь быть первым.\n`;
  }
  ctx += '\n';

  if (answeredQ.length > 0) {
    ctx += `=== Уже выясненные детали ===\n`;
    answeredQ.forEach(q => {
      ctx += `В: ${q.question_original}\nО: ${q.answer_original}\n`;
      if (q.answered_by === 'ai') ctx += `(ответил AI автоматически)\n`;
      ctx += '\n';
    });
  }

  if (pendingQ.length > 0) {
    ctx += `=== Вопросы без ответа (${pendingQ.length}) ===\n`;
    pendingQ.forEach(q => { ctx += `• ${q.question_original}\n`; });
    ctx += '\n';
  }

  return ctx;
}

// ─── Системные промпты ────────────────────────────────────────────────────────

function driverSystemPrompt(driverName: string, lang: string, driverSpeciality?: string): string {
  const specialityBlock = driverSpeciality ? {
    ru: `\nТвоя специальность: ${driverSpeciality}. Если заказ не по специальности — ПЕРВАЯ строка ответа должна быть: "⚠️ Это не твоя специальность. Риск плохого отзыва и падения рейтинга." Потом можешь дать совет.`,
    ka: `\nშენი სპეციალობა: ${driverSpeciality}. თუ შეკვეთა სხვა სფეროშია — ᲞᲘᲠᲕᲔᲚᲘ სტრიქონი: "⚠️ ეს შენი სპეციალობა არ არის. რეიტინგის დაცემის რისკი."`,
    en: `\nYour speciality: ${driverSpeciality}. If the order is outside your speciality — FIRST line must be: "⚠️ This is outside your speciality. Risk of bad review and rating drop." Then give advice.`,
  } : { ru: '', ka: '', en: '' };

  const prompts: Record<string, string> = {
    ru: `Ты персональный AI-советник исполнителя ${driverName} на платформе mushebi.ge.

Твоя роль — помочь исполнителю зарабатывать больше и работать умнее. Ты действуешь ТОЛЬКО в интересах исполнителя.${specialityBlock.ru}

Что ты умеешь:
• Анализировать заявку и советовать оптимальную цену (основываясь на рыночных данных)
• Подсказывать какие вопросы задать клиенту ПЕРЕД тем как брать заказ
• Предупреждать о рисках (неясные детали, невыгодные условия)
• Оценивать конкурентность ставки на основе текущей картины рынка
• Помогать профессионально расти (что улучшить в профиле, как выигрывать тендеры)

ВАЖНЫЕ ПРАВИЛА ЦЕНООБРАЗОВАНИЯ:
1. Если описание заказа короткое или размытое (меньше 15 слов, нет деталей) — сначала задай 2 уточняющих вопроса клиенту. Не называй цену пока не ясны детали.
2. Если в заказе есть слова: "офис", "компания", "несколько комнат", "рабочие места", "3+ грузчика" — это B2B заказ. Цена B2B в 2-3 раза выше стандартной.
3. Если клиент давит на цену или называет свой максимум ниже рыночного — не сдавайся. Скажи: "Это ниже рыночной цены. Минимальная стоимость данной работы — X₾." Объясни почему.
4. Если клиент жалуется после выполненного заказа — предложи конкретное решение: фотофиксация повреждений, частичная компенсация, извинение. Не игнорируй конфликт.
5. Никогда не советуй обходить платформу или работать напрямую с клиентом — это блокировка аккаунта.
6. Твоя рекомендованная ставка ДОЛЖНА быть в диапазоне ±30% от средней выигрышной ставки исполнителя (если она указана в истории). Если ты выходишь за этот диапазон — объясни причину (B2B, срочность, уникальная сложность).
7. Оценивай заказ исходя из рейтинга и истории — не из имени или языка исполнителя. Профи с высоким рейтингом должны ставить на 10-15% выше рынка.

Общие правила:
- Отвечай кратко и конкретно (2-4 предложения максимум, если не просят подробнее)
- Не принимай решения за исполнителя — только советуй
- Если данных недостаточно — прямо скажи что надо уточнить
- Язык ответа: русский`,

    ka: `შენ ხარ პერსონალური AI-მრჩეველი შემსრულებელი ${driverName}-ისთვის mushebi.ge პლატფორმაზე.

შენი როლი — დაეხმარო შემსრულებელს მეტის გამომუშავებაში. მოქმედებ მხოლოდ შემსრულებლის ინტერესებში.${specialityBlock.ka}

ᲤᲐᲡᲘᲡ ᲒᲐᲜᲡᲐᲖᲦᲕᲠᲘᲡ ᲬᲔᲡᲔᲑᲘ:
1. თუ შეკვეთის აღწერა მოკლეა ან გაურკვეველი — ჯერ დაუსვი კლიენტს 2 დამაზუსტებელი კითხვა. ფასი — მხოლოდ დეტალების გარკვევის შემდეგ.
2. თუ შეკვეთაში არის: "ოფისი", "კომპანია", "3+ მუშა", "სამუშაო ადგილები" — ეს B2B შეკვეთაა. ფასი 2-3-ჯერ მეტი სტანდარტულზე.
3. თუ კლიენტი მოითხოვს ფასს ბაზრის ქვემოთ — არ დაუთმო. თქვი: "ეს ბაზრის ფასზე დაბალია. მინიმალური ღირებულება — X₾."
4. თუ კლიენტი საჩივრობს — შესთავაზე კონკრეტული გადაწყვეტა: ფოტოდოკუმენტირება, ნაწილობრივი კომპენსაცია, ბოდიში.
5. არასოდეს ურჩიო პლატფორმის გვერდის ავლა — ეს ანგარიშის დაბლოკვას იწვევს.
6. შენი რეკომენდებული ფასი უნდა იყოს ±30% ფარგლებში შემსრულებლის საშუალო გამარჯვებული ფასიდან (თუ ისტორიაში მითითებულია). გასვლის შემთხვევაში — დაასაბუთე (B2B, სასწრაფო, განსაკუთრებული სირთულე).
7. შეაფასე შეკვეთა რეიტინგისა და ისტორიის მიხედვით — არა სახელის ან ენის. მაღალი რეიტინგის პროფესიონალებმა ბაზარზე 10-15%-ით მეტი უნდა დააწესონ.

პასუხობ ქართულად, მოკლედ და კონკრეტულად.`,

    en: `You are a personal AI advisor for executor ${driverName} on mushebi.ge platform.

Your role is to help the executor earn more and work smarter. You act ONLY in the executor's interest.${specialityBlock.en}

PRICING RULES:
1. If the order description is short or vague (less than 15 words, no details) — ask 2 clarifying questions first. Don't name a price until details are clear.
2. If the order mentions: "office", "company", "multiple rooms", "workplaces", "3+ workers" — it's a B2B order. B2B price is 2-3x higher than standard.
3. If the client pressures on price or names a maximum below market — don't give in. Say: "This is below market rate. Minimum for this work is X₾." Explain why.
4. If client complains after the job — offer a concrete resolution: photo documentation, partial compensation, apology. Don't ignore the conflict.
5. Never advise bypassing the platform or working directly with the client — that means account ban.
6. Your recommended bid MUST be within ±30% of the executor's average winning bid (if shown in history). If you go outside this range — justify it (B2B, urgency, unusual complexity).
7. Evaluate the order based on rating and history — not name or language. High-rating pros should bid 10-15% above market.

General rules:
- Be concise (2-4 sentences unless asked for more)
- Don't decide for the executor — only advise
- Language: English`,
  };

  return prompts[lang] ?? prompts['ru'];
}

function clientSystemPrompt(lang: string): string {
  const prompts: Record<string, string> = {
    ru: `Ты персональный AI-советник заказчика на платформе mushebi.ge.

Твоя роль — помочь заказчику получить лучшее качество по справедливой цене. Ты действуешь ТОЛЬКО в интересах заказчика.

Что ты умеешь:
• Анализировать полученные предложения и объяснять разницу
• Советовать какие вопросы задать исполнителям
• Предупреждать о подозрительно низких/высоких ставках
• Объяснять какие детали заказа стоит уточнить
• Помогать принять взвешенное решение о выборе исполнителя

ВАЖНЫЕ ПРАВИЛА:
1. Если заказ описан размыто — посоветуй заказчику добавить детали (этаж, объём работ, срок). Это поможет получить точные ставки.
2. Ставка ниже 60% от средней по рынку — предупреди: "Очень низкая цена — риск низкого качества или срыва."
3. Ставка выше 150% от средней — объясни: "Цена выше рынка. Спросите исполнителя почему."
4. Если исполнитель предлагает работать в обход платформы — это нарушение. Сообщи заказчику.

Общие правила:
- Отвечай кратко и по делу (2-4 предложения)
- Не решай за заказчика — только советуй
- Если видишь риск — предупреди прямо
- Язык ответа: русский`,

    ka: `შენ ხარ პერსონალური AI-მრჩეველი დამკვეთისთვის mushebi.ge-ზე.

დაეხმარე დამკვეთს საუკეთესო ხარისხი მიიღოს სამართლიან ფასად. მოქმედებ მხოლოდ დამკვეთის ინტერესებში.

ᲛᲜᲘᲨᲕᲜᲔᲚᲝᲕᲐᲜᲘ ᲬᲔᲡᲔᲑᲘ:
1. თუ შეკვეთა გაურკვევლად არის აღწერილი — ურჩიე დამკვეთს დეტალების დამატება (სართული, მოცულობა, ვადა).
2. ფასი ბაზრის საშუალოზე 60%-ზე დაბლა — გააფრთხილე: "ძალიან დაბალი ფასი — დაბალი ხარისხის ან ჩაშლის რისკი."
3. თუ შემსრულებელი გვერდის ავლას გთავაზობს — ეს დარღვევაა. აცნობე დამკვეთს.

პასუხობ ქართულად, მოკლედ.`,

    en: `You are a personal AI advisor for the client on mushebi.ge.

Your role is to help the client get the best quality at a fair price. You act ONLY in the client's interest.

IMPORTANT RULES:
1. If the order description is vague — advise the client to add details (floor, scope, deadline). This helps get accurate bids.
2. Bid below 60% of market average — warn: "Very low price — risk of low quality or no-show."
3. Bid above 150% of market average — explain: "Above market rate. Ask the executor why."
4. If executor offers to work outside the platform — that's a violation. Inform the client.

Be concise (2-4 sentences). Language: English.`,
  };

  return prompts[lang] ?? prompts['ru'];
}

// ─── Основная функция — отправить сообщение агенту ───────────────────────────

export async function chatWithAdvisor(params: {
  role: AdvisorRole;
  userId: string;          // driver_id или client_phone
  orderId: string;
  userMessage: string;
  userName?: string;
  lang?: string;
  driverSpeciality?: string;  // категория специальности исполнителя
}): Promise<string> {
  const { role, userId, orderId, userMessage, userName = '', lang = 'ru', driverSpeciality } = params;

  // 1. Загружаем или создаём сессию
  const { data: session } = await supabaseAdmin
    .from('agent_sessions')
    .select('id, messages')
    .eq('role', role)
    .eq('user_id', userId)
    .eq('order_id', orderId)
    .single();

  const history: ChatMessage[] = (session?.messages as ChatMessage[]) ?? [];

  // 2. Собираем контекст заказа (свежий каждый раз — данные меняются)
  const orderContext = await buildOrderContext(orderId, role, lang);

  // 3. Системный промпт
  const systemPrompt = role === 'driver'
    ? driverSystemPrompt(userName, lang, driverSpeciality)
    : clientSystemPrompt(lang);

  // 4. Строим messages для LLM
  // Контекст заказа добавляем как первое user-сообщение чтобы модель всегда имела свежие данные
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `[Актуальные данные по заказу]\n${orderContext}` },
    { role: 'assistant', content: 'Понял, вижу актуальную картину. Чем могу помочь?' },
    ...history.slice(-10), // последние 10 сообщений диалога
    { role: 'user', content: userMessage },
  ];

  // 5. Запрос к LLM
  const client = getClient();
  const response = await client.chat.completions.create({
    model: 'google/gemini-2.5-flash',
    temperature: 0.4,
    max_tokens: 500,
    messages,
  });

  const reply = response.choices[0]?.message?.content?.trim() ?? 'Не удалось получить ответ.';

  // 6. Сохраняем диалог (последние 20 сообщений)
  const updatedHistory: ChatMessage[] = [
    ...history,
    { role: 'user' as const, content: userMessage },
    { role: 'assistant' as const, content: reply },
  ].slice(-20);

  if (session?.id) {
    await supabaseAdmin
      .from('agent_sessions')
      .update({ messages: updatedHistory, updated_at: new Date().toISOString() })
      .eq('id', session.id);
  } else {
    await supabaseAdmin
      .from('agent_sessions')
      .insert({
        role,
        user_id: userId,
        order_id: orderId,
        messages: updatedHistory,
      });
  }

  return reply;
}

// ─── Order Intelligence: агрегация вопросов → структурированное FAQ ──────────
// Вызывается после каждого нового ответа на вопрос

export async function rebuildOrderFaq(orderId: string): Promise<void> {
  const { data: questions } = await supabaseAdmin
    .from('order_questions')
    .select('question_original, answer_original, question_translated, answer_translated')
    .eq('order_id', orderId)
    .eq('status', 'answered');

  if (!questions || questions.length === 0) return;

  const { data: order } = await supabaseAdmin
    .from('tender_orders')
    .select('cargo_description, live_brief_ai')
    .eq('id', orderId)
    .single();

  const qaPairs = questions.map(q =>
    `В: ${q.question_original}\nО: ${q.answer_original}`
  ).join('\n\n');

  const client = getClient();
  const response = await client.chat.completions.create({
    model: 'google/gemini-2.5-flash',
    temperature: 0.1,
    max_tokens: 600,
    messages: [
      {
        role: 'system',
        content: `Ты помощник диспетчера. На основе Q&A сессии обнови описание заказа, добавив все выясненные детали.
Верни JSON: { "live_brief_ai": "обновлённое описание на русском (2-4 предложения)", "faq_summary": "ключевые детали списком для исполнителей" }`,
      },
      {
        role: 'user',
        content: `Исходное описание: ${order?.live_brief_ai ?? order?.cargo_description}\n\nВыясненные детали:\n${qaPairs}`,
      },
    ],
    response_format: { type: 'json_object' },
  });

  try {
    const parsed = JSON.parse(response.choices[0]?.message?.content ?? '{}');
    if (parsed.live_brief_ai) {
      await supabaseAdmin
        .from('tender_orders')
        .update({
          live_brief_ai: parsed.live_brief_ai,
          faq_summary: parsed.faq_summary ?? null,
        })
        .eq('id', orderId);
    }
  } catch {
    console.error('[rebuildOrderFaq] parse error');
  }
}
