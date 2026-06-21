/**
 * buildCard() — единственный источник правды для карточки заказа в Telegram.
 * Вызывается из: bot.ts, sendTenderToDrivers, answer/route.ts
 */

import { InlineKeyboard } from 'grammy';

export type CardState = 'idle' | 'asking' | 'bidding' | 'winner' | 'closed';

export interface CardOrder {
  id: string;
  order_number: number;
  cargo_description: string | null;
  localized_description: unknown;
  client_budget: unknown;
  media_urls: unknown;
  scheduled_at?: string | null;
  notes?: string | null;
}

export interface CardDriver {
  id: string;
  driver_language: string;
  telegram_id: number;
}

export interface CardBid {
  amount: number;
  status: string;
  bot_state: CardState;
  card_type?: string | null;
}

export interface CardQuestion {
  question_original: string;
  answer_translated: unknown;
  status: string;
}

export interface CardResult {
  text: string;
  keyboard: InlineKeyboard;
}

const BID_AMOUNTS = [100, 130, 150, 180];

export function buildCard(
  order: CardOrder,
  driver: CardDriver,
  bid: CardBid | null,
  myQuestions: CardQuestion[],
  allAnsweredQuestions: CardQuestion[],
  bidCount?: number,
): CardResult {
  const lang = driver.driver_language;
  const orderId = order.id;

  const localized = order.localized_description as Record<string, string> | null;
  const description = localized?.[lang] ?? localized?.['ru'] ?? order.cargo_description ?? '';
  const budget = order.client_budget as number | null;
  const hasMedia = Array.isArray(order.media_urls) && (order.media_urls as unknown[]).length > 0;

  const scheduledAt = order.scheduled_at ?? null;
  const notes = order.notes ?? null;

  // Заголовок с номером заказа
  const headers: Record<string, string> = {
    ru: `📦 ЗАКАЗ #${order.order_number} — mushebi.ge`,
    ka: `📦 შეკვეთა #${order.order_number} — mushebi.ge`,
    en: `📦 ORDER #${order.order_number} — mushebi.ge`,
  };

  const whenLabel: Record<string, string> = { ru: '📅 Когда', ka: '📅 როდის', en: '📅 When' };
  const notesLabel: Record<string, string> = { ru: '📝 Примечания', ka: '📝 შენიშვნები', en: '📝 Notes' };
  const budgetLabel: Record<string, string> = {
    ru: `💰 Бюджет: до ${budget} ₾`,
    ka: `💰 ბიუჯეტი: ${budget} ₾`,
    en: `💰 Budget: up to ${budget} ₾`,
  };

  const when = scheduledAt
    ? new Date(scheduledAt).toLocaleString(
        lang === 'ka' ? 'ka-GE' : lang === 'en' ? 'en-US' : 'ru-RU',
        { timeZone: 'Asia/Tbilisi', dateStyle: 'short', timeStyle: 'short' }
      )
    : (lang === 'ka' ? 'რაც შეიძლება მალე' : lang === 'en' ? 'As soon as possible' : 'как можно скорее');

  let text = `${headers[lang] ?? headers.ru}\n\n📋 ${description}\n`;
  if (bidCount !== undefined && bidCount > 0) {
    text += lang === 'ka' ? `👥 შეთავაზება: ${bidCount}\n`
      : lang === 'en' ? `👥 Bids: ${bidCount}\n`
      : `👥 Ставок: ${bidCount}\n`;
  }
  text += `${whenLabel[lang] ?? whenLabel.ru}: ${when}\n`;
  if (budget) text += `${budgetLabel[lang] ?? budgetLabel.ru}\n`;
  if (notes) text += `${notesLabel[lang] ?? notesLabel.ru}: ${notes}\n`;
  if (hasMedia) text += lang === 'ka' ? '📷 ფოტო არის\n' : lang === 'en' ? '📷 Has photos\n' : '📷 Есть фото\n';

  const state = bid?.bot_state ?? 'idle';

  // Чужие отвеченные вопросы (анонимно) — показываем во всех состояниях
  const othersAnswered = allAnsweredQuestions.filter(
    q => !myQuestions.find(my => my.question_original === q.question_original)
  );
  if (othersAnswered.length > 0) {
    text += lang === 'ka' ? '\n💡 სხვების კითხვები:\n'
      : lang === 'en' ? '\n💡 Others asked:\n'
      : '\n💡 Вопросы других:\n';
    for (const q of othersAnswered) {
      const ans = q.answer_translated as Record<string, string> | null;
      const ansText = ans?.[lang] ?? ans?.['ru'] ?? '';
      text += `❓ ${q.question_original}\n💬 ${ansText}\n`;
    }
  }

  // Свои вопросы
  if (myQuestions.length > 0) {
    text += lang === 'ka' ? '\n── თქვენი კითხვები ──\n'
      : lang === 'en' ? '\n── Your questions ──\n'
      : '\n── Ваши вопросы ──\n';
    for (const q of myQuestions) {
      const ans = q.answer_translated as Record<string, string> | null;
      const ansText = ans?.[lang] ?? ans?.['ru'];
      text += q.status === 'answered' && ansText
        ? `❓ ${q.question_original}\n💬 ${ansText}\n`
        : `❓ ${q.question_original}\n⏳ ${lang === 'ka' ? 'პასუხს ელოდება' : lang === 'en' ? 'Awaiting answer' : 'Ожидает ответа'}\n`;
    }
  }

  const keyboard = new InlineKeyboard();

  // Состояние CLOSED — показываем после Q&A
  if (state === 'closed') {
    text += lang === 'ka' ? '\n🔒 შეკვეთა დახურულია — სხვა შემსრულებელი შეირჩა'
      : lang === 'en' ? '\n🔒 Order closed — another executor was selected'
      : '\n🔒 Заказ закрыт — выбран другой исполнитель';
    return { text, keyboard };
  }

  // Состояние WINNER — показываем после Q&A
  if (state === 'winner') {
    text += lang === 'ka' ? '\n🏆 თქვენ არჩეული ხართ! კლიენტი მალე დაგიკავშირდებათ.'
      : lang === 'en' ? '\n🏆 You are selected! The client will contact you soon.'
      : '\n🏆 Вы выбраны! Клиент скоро свяжется с вами.';
    return { text, keyboard };
  }

  // Состояние ASKING
  if (state === 'asking') {
    text += lang === 'ka' ? '\n✍️ დაწერეთ კითხვა კლიენტს:'
      : lang === 'en' ? '\n✍️ Write your question to the client:'
      : '\n✍️ Напишите вопрос клиенту:';
    keyboard.text(
      lang === 'ka' ? '❌ გაუქმება' : lang === 'en' ? '❌ Cancel' : '❌ Отмена',
      `cancel:${orderId}`
    );
    return { text, keyboard };
  }

  // Состояние BIDDING
  if (state === 'bidding') {
    text += lang === 'ka' ? '\n✍️ შეიყვანეთ თქვენი თანხა (მხოლოდ რიცხვი):'
      : lang === 'en' ? '\n✍️ Enter your price (number only):'
      : '\n✍️ Введите вашу сумму (только число):';
    keyboard.text(
      lang === 'ka' ? '❌ გაუქმება' : lang === 'en' ? '❌ Cancel' : '❌ Отмена',
      `cancel:${orderId}`
    );
    return { text, keyboard };
  }

  // Состояние IDLE с активной ставкой
  if (bid && bid.amount > 0 && bid.status === 'pending') {
    text += `\n✅ ${lang === 'ka' ? 'თქვენი შეთავაზება' : lang === 'en' ? 'Your bid' : 'Ваша ставка'}: ${bid.amount} ₾`;
    keyboard
      .text(lang === 'ka' ? '✏️ შეცვლა' : lang === 'en' ? '✏️ Change price' : '✏️ Изменить цену', `offer:${orderId}`)
      .text(lang === 'ka' ? '❌ გაუქმება' : lang === 'en' ? '❌ Withdraw' : '❌ Отозвать', `withdraw:${orderId}`);
    keyboard.row().text(
      lang === 'ka' ? '❓ კითხვა კლიენტს' : lang === 'en' ? '❓ Ask question' : '❓ Задать вопрос',
      `ask_question:${orderId}`
    );
    return { text, keyboard };
  }

  // Состояние IDLE без ставки
  BID_AMOUNTS.forEach(a => keyboard.text(`${a} ₾`, `bid:${orderId}:${a}`));
  keyboard.row().text(
    lang === 'ka' ? '✍️ სხვა ფასი' : lang === 'en' ? '✍️ Custom price' : '✍️ Своя цена',
    `offer:${orderId}`
  );
  keyboard.row().text(
    lang === 'ka' ? '❓ კითხვა კლიენტს' : lang === 'en' ? '❓ Ask question' : '❓ Задать вопрос',
    `ask_question:${orderId}`
  );

  return { text, keyboard };
}

// Вспомогательная функция — загружает все данные для карточки из Supabase и строит её
import { supabaseAdmin } from '@/lib/supabase';
import { bot } from '@/lib/telegram/bot';

export async function refreshCard(
  telegramId: number,
  messageId: number,
  orderId: string,
): Promise<void> {
  const { data: order } = await supabaseAdmin
    .from('tender_orders')
    .select('id, order_number, cargo_description, localized_description, scheduled_at, notes, media_urls, status, client_budget')
    .eq('id', orderId)
    .single();
  if (!order) return;

  const { data: driver } = await supabaseAdmin
    .from('tender_drivers')
    .select('id, driver_language, telegram_id')
    .eq('telegram_id', telegramId)
    .single();
  if (!driver) return;

  const { data: bid } = await supabaseAdmin
    .from('tender_bids')
    .select('amount, status, bot_state, card_type')
    .eq('order_id', orderId)
    .eq('driver_id', driver.id)
    .single();

  const { data: myQuestions } = await supabaseAdmin
    .from('order_questions')
    .select('question_original, answer_translated, status')
    .eq('order_id', orderId)
    .eq('driver_id', driver.id)
    .order('created_at', { ascending: true });

  const { data: allAnswered } = await supabaseAdmin
    .from('order_questions')
    .select('question_original, answer_translated, status')
    .eq('order_id', orderId)
    .eq('status', 'answered')
    .order('created_at', { ascending: true });

  const { count: bidCount } = await supabaseAdmin
    .from('tender_bids')
    .select('id', { count: 'exact', head: true })
    .eq('order_id', orderId)
    .neq('status', 'withdrawn')
    .gt('amount', 0);

  const { text, keyboard } = buildCard(
    order as CardOrder,
    driver as CardDriver,
    bid as CardBid | null,
    myQuestions ?? [],
    allAnswered ?? [],
    bidCount ?? undefined,
  );

  const isPhoto = bid?.card_type === 'photo';
  if (isPhoto) {
    await bot.api.editMessageCaption(telegramId, messageId, {
      caption: text.slice(0, 1024),
      reply_markup: keyboard,
    }).catch(() => {});
  } else {
    await bot.api.editMessageText(telegramId, messageId, text, {
      reply_markup: keyboard,
    }).catch(() => {});
  }
}

// Обновляет карточки ВСЕХ исполнителей по заказу (вызывается когда клиент отвечает)
export async function refreshAllCards(orderId: string): Promise<void> {
  const { data: order } = await supabaseAdmin
    .from('tender_orders')
    .select('id, order_number, cargo_description, localized_description, scheduled_at, notes, media_urls, status, client_budget')
    .eq('id', orderId)
    .single();
  if (!order) return;

  const { data: bids } = await supabaseAdmin
    .from('tender_bids')
    .select('driver_id, amount, status, bot_state, card_type, telegram_message_id')
    .eq('order_id', orderId);
  if (!bids || bids.length === 0) return;

  const driverIds = bids.map(b => b.driver_id);
  const { data: drivers } = await supabaseAdmin
    .from('tender_drivers')
    .select('id, driver_language, telegram_id')
    .in('id', driverIds);
  if (!drivers) return;

  const { data: allAnswered } = await supabaseAdmin
    .from('order_questions')
    .select('question_original, answer_translated, status')
    .eq('order_id', orderId)
    .eq('status', 'answered')
    .order('created_at', { ascending: true });

  const { count: bidCount } = await supabaseAdmin
    .from('tender_bids')
    .select('id', { count: 'exact', head: true })
    .eq('order_id', orderId)
    .neq('status', 'withdrawn')
    .gt('amount', 0);

  await Promise.all(
    bids.map(async bid => {
      const driver = drivers.find(d => d.id === bid.driver_id);
      if (!driver?.telegram_id || !bid.telegram_message_id) return;

      const { data: myQuestions } = await supabaseAdmin
        .from('order_questions')
        .select('question_original, answer_translated, status')
        .eq('order_id', orderId)
        .eq('driver_id', driver.id)
        .order('created_at', { ascending: true });

      const { text, keyboard } = buildCard(
        order as CardOrder,
        driver as CardDriver,
        bid as CardBid,
        myQuestions ?? [],
        allAnswered ?? [],
        bidCount ?? undefined,
      );

      const isPhoto = bid.card_type === 'photo';
      if (isPhoto) {
        await bot.api.editMessageCaption(
          Number(driver.telegram_id),
          Number(bid.telegram_message_id),
          { caption: text.slice(0, 1024), reply_markup: keyboard },
        ).catch(() => {});
      } else {
        await bot.api.editMessageText(
          Number(driver.telegram_id),
          Number(bid.telegram_message_id),
          text,
          { reply_markup: keyboard },
        ).catch(() => {});
      }
    })
  );
}
