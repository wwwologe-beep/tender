import { Bot, Context, InlineKeyboard } from 'grammy';
import { supabaseAdmin } from '@/lib/supabase';
import { chatWithAdvisor } from '@/lib/ai-advisor';
import { translateChatMessage } from '@/lib/ai';
import { buildCard, refreshCard, type CardOrder, type CardDriver, type CardBid } from '@/lib/telegram/card';

export const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN!);

const ADMIN_TELEGRAM_ID = process.env.TELEGRAM_ADMIN_ID
  ? parseInt(process.env.TELEGRAM_ADMIN_ID)
  : 7182392547;

type ReplyWaitingState = { orderId: string; orderToken: string; promptMessageId?: number; type?: 'message' | 'meeting_time' };

async function getReplyWaiting(telegramId: number): Promise<ReplyWaitingState | null> {
  const { data } = await supabaseAdmin
    .from('tender_drivers').select('reg_state').eq('telegram_id', telegramId).single();
  return (data?.reg_state as Record<string, unknown>)?.reply_waiting as ReplyWaitingState ?? null;
}

async function setReplyWaiting(telegramId: number, state: ReplyWaitingState | null) {
  const { data } = await supabaseAdmin
    .from('tender_drivers').select('reg_state').eq('telegram_id', telegramId).single();
  const current = (data?.reg_state as Record<string, unknown>) ?? {};
  if (state === null) {
    delete current.reply_waiting;
  } else {
    current.reply_waiting = state;
  }
  await supabaseAdmin.from('tender_drivers').update({ reg_state: current }).eq('telegram_id', telegramId);
}

// ─── /start ───────────────────────────────────────────────────────────────────

bot.command('start', async (ctx) => {
  const telegramId = ctx.from!.id;

  const { data: existing } = await supabaseAdmin
    .from('tender_drivers')
    .select('id, name, status, reg_state')
    .eq('telegram_id', telegramId)
    .single();

  if (existing && !existing.reg_state) {
    const statusText =
      existing.status === 'active'
        ? '✅ Вы активны и получаете заказы.'
        : '⏳ Ваш аккаунт ожидает подтверждения администратора.';
    await ctx.reply(`${existing.name}, вы уже зарегистрированы.\n\n${statusText}`);
    return;
  }

  // Reset reg_state and start fresh
  if (existing) {
    await supabaseAdmin.from('tender_drivers').update({ reg_state: { step: 'name' } }).eq('id', existing.id);
  } else {
    // Will be created at reg_spec step — just store state in a temp record
    await supabaseAdmin.from('tender_drivers').upsert(
      { telegram_id: telegramId, reg_state: { step: 'name' }, status: 'registering', name: '', phone: '' },
      { onConflict: 'telegram_id' }
    );
  }

  await ctx.reply(
    '👋 Добро пожаловать в mushebi.ge!\n\nЭто бот для исполнителей — грузчиков, водителей и мастеров.\n\nДля начала введите ваше имя и фамилию:'
  );
});

// ─── Обработка текстовых сообщений ───────────────────────────────────────────

bot.on('message:text', async (ctx) => {
  const telegramId = ctx.from!.id;
  const text = ctx.message.text.trim();

  const { data: driver } = await supabaseAdmin
    .from('tender_drivers')
    .select('id, name, status, driver_language, active_order_id, reg_state')
    .eq('telegram_id', telegramId)
    .single();

  if (!driver) return;

  // ─── Шаги регистрации (reg_state в БД) ───────────────────────────────────
  const regState = driver.reg_state as Record<string, string> | null;
  if (regState?.step === 'name' || regState?.step === 'phone') {
    const state = regState;

    if (state.step === 'name') {
      if (text.length < 2) {
        await ctx.reply('Введите настоящее имя (минимум 2 символа):');
        return;
      }
      await supabaseAdmin.from('tender_drivers').update({
        reg_state: { step: 'phone', name: text },
        name: text,
      }).eq('id', driver.id);
      await ctx.reply('Введите номер телефона или нажмите кнопку ниже:', {
        reply_markup: {
          keyboard: [[{ text: '📱 Поделиться контактом', request_contact: true }]],
          resize_keyboard: true,
          one_time_keyboard: true,
        },
      });
      return;
    }

    if (state.step === 'phone') {
      const normalized = normalizePhone(text);
      if (!normalized) {
        await ctx.reply('Неверный формат. Попробуйте ещё раз или нажмите кнопку ниже.', {
          reply_markup: {
            keyboard: [[{ text: '📱 Поделиться контактом', request_contact: true }]],
            resize_keyboard: true,
            one_time_keyboard: true,
          },
        });
        return;
      }
      await proceedWithPhone(ctx, driver.id, state, normalized);
      return;
    }
    return;
  }

  if (driver.status !== 'active') {
    await ctx.reply('⏳ Ваш аккаунт ещё не подтверждён администратором.');
    return;
  }

  const lang = (driver.driver_language ?? 'ru') as string;

  // ─── bot_state из активной ставки ────────────────────────────────────────
  // Ищем ставку где bot_state != idle и не истёк таймаут 2 часа
  const TWO_HOURS_AGO = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const { data: activeBidState } = await supabaseAdmin
    .from('tender_bids')
    .select('order_id, bot_state, bot_state_updated_at, telegram_message_id, amount, status')
    .eq('driver_id', driver.id)
    .in('bot_state', ['asking', 'bidding'])
    .gt('bot_state_updated_at', TWO_HOURS_AGO)
    .order('bot_state_updated_at', { ascending: false })
    .limit(1)
    .single();

  // ─── Ожидание ВОПРОСА клиенту (bot_state = 'asking') ─────────────────────
  if (activeBidState?.bot_state === 'asking') {
    const orderId = activeBidState.order_id;
    const messageId = Number(activeBidState.telegram_message_id);

    // Удаляем сообщение пользователя — лента остаётся чистой
    await bot.api.deleteMessage(telegramId, ctx.message.message_id).catch(() => {});

    // Сбрасываем bot_state
    await supabaseAdmin
      .from('tender_bids')
      .update({ bot_state: 'idle', bot_state_updated_at: new Date().toISOString() })
      .eq('order_id', orderId)
      .eq('driver_id', driver.id);

    // Проверяем лимит вопросов (max 3 per driver per order)
    const { count } = await supabaseAdmin
      .from('order_questions')
      .select('id', { count: 'exact', head: true })
      .eq('order_id', orderId)
      .eq('driver_id', driver.id);

    if ((count ?? 0) >= 3) {
      // Показываем ошибку прямо в карточке через answerCallbackQuery не получится —
      // вместо этого кратко обновляем карточку (она уже сбрасит состояние asking)
      if (messageId) await refreshCard(telegramId, messageId, orderId);
      return;
    }

    // Сохраняем вопрос через API (AI dedup + translation)
    const res = await fetch(`${process.env.NEXT_PUBLIC_APP_URL ?? 'https://mushebi.ge'}/api/questions/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order_id: orderId, driver_id: driver.id, question: text, lang }),
    });

    // Независимо от результата — обновляем карточку (она покажет вопрос или останется прежней)
    if (messageId) await refreshCard(telegramId, messageId, orderId);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      // Ошибку показываем всплывающим уведомлением — не засоряем чат
      console.error('[ask question error]', err);
    }
    return;
  }

  // ─── Ожидание ЦЕНЫ (bot_state = 'bidding') ───────────────────────────────
  if (activeBidState?.bot_state === 'bidding') {
    const orderId = activeBidState.order_id;
    const messageId = Number(activeBidState.telegram_message_id);

    const amount = parseInt(text);

    // Удаляем сообщение пользователя — лента остаётся чистой
    await bot.api.deleteMessage(telegramId, ctx.message.message_id).catch(() => {});

    if (isNaN(amount) || amount <= 0) {
      // Некорректная сумма — возвращаем карточку в bidding состояние (инструкция видна)
      if (messageId) await refreshCard(telegramId, messageId, orderId);
      return;
    }

    // Сохраняем ставку и сбрасываем bot_state
    await supabaseAdmin.from('tender_bids').upsert(
      {
        order_id: orderId,
        driver_id: driver.id,
        amount,
        status: 'pending',
        bot_state: 'idle',
        bot_state_updated_at: new Date().toISOString(),
        telegram_message_id: activeBidState.telegram_message_id,
      },
      { onConflict: 'order_id,driver_id' }
    );

    if (messageId) await refreshCard(telegramId, messageId, orderId);
    return;
  }

  // ─── Ожидание ответа клиенту (reply_waiting в reg_state БД) ─────────────────
  const replyCtx = await getReplyWaiting(telegramId);
  if (replyCtx) {
    await setReplyWaiting(telegramId, null);

    // Удаляем сообщение пользователя и промпт бота
    await bot.api.deleteMessage(telegramId, ctx.message.message_id).catch(() => {});
    if (replyCtx.promptMessageId) {
      await bot.api.deleteMessage(telegramId, replyCtx.promptMessageId).catch(() => {});
    }

    // ─── Ввод времени встречи ──────────────────────────────────────────────
    if (replyCtx.type === 'meeting_time') {
      const orderId = replyCtx.orderId;
      const meetingTime = parseMeetingTime(text);

      if (!meetingTime) {
        const errMsgs: Record<string, string> = {
          ru: '❌ Не понял время. Введите например: "14:00" или "завтра 10:00"',
          ka: '❌ დრო ვერ გავიგე. შეიყვანეთ მაგ: "14:00" ან "ხვალ 10:00"',
          en: '❌ Could not parse time. Try: "14:00" or "tomorrow 10:00"',
        };
        // Возвращаем состояние обратно
        const promptMsg = await ctx.reply(errMsgs[lang] ?? errMsgs.ru);
        await setReplyWaiting(telegramId, { ...replyCtx, promptMessageId: promptMsg.message_id });
        return;
      }

      await supabaseAdmin
        .from('tender_orders')
        .update({ meeting_time: meetingTime.toISOString(), meeting_confirmed: false })
        .eq('id', orderId);

      // Уведомляем исполнителя
      const confirmMsgs: Record<string, string> = {
        ru: `✅ Время встречи установлено: ${formatMeetingTime(meetingTime, 'ru')}\n\nКлиент получит уведомление для подтверждения.`,
        ka: `✅ შეხვედრის დრო დაყენდა: ${formatMeetingTime(meetingTime, 'ka')}\n\nკლიენტი მიიღებს შეტყობინებას დასადასტურებლად.`,
        en: `✅ Meeting time set: ${formatMeetingTime(meetingTime, 'en')}\n\nClient will be notified to confirm.`,
      };
      await ctx.reply(confirmMsgs[lang] ?? confirmMsgs.ru);

      // Push клиенту
      const { data: order } = await supabaseAdmin
        .from('tender_orders')
        .select('token, push_subscription, client_phone')
        .eq('id', orderId).single();

      if (order?.push_subscription && order.token) {
        const { sendPush } = await import('@/lib/push');
        await sendPush(order.push_subscription as Parameters<typeof sendPush>[0], {
          title: '📅 Исполнитель назначил время встречи',
          body: `Будет у вас в ${formatMeetingTime(meetingTime, 'ru')} — подтвердите`,
          url: `/feed/${order.token}`,
        }).catch(() => {});
      }

      // WhatsApp fallback
      const wappiToken = process.env.WAPPI_TOKEN;
      const wappiProfile = process.env.WAPPI_PROFILE_ID;
      if (wappiToken && wappiProfile && order?.client_phone && order.token) {
        const url = `https://mushebi.ge/feed/${order.token}`;
        const waText = `📅 Исполнитель будет у вас в ${formatMeetingTime(meetingTime, 'ru')}.\n\nПодтвердите встречу здесь: ${url}`;
        await fetch(`https://wappi.pro/api/sync/message/send?profile_id=${wappiProfile}`, {
          method: 'POST',
          headers: { Authorization: wappiToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ body: waText, recipient: (order.client_phone as string).replace('+', '') }),
        }).catch(() => {});
      }
      return;
    }

    if (replyCtx.orderToken.startsWith('__sos__')) {
      const orderId = replyCtx.orderToken.replace('__sos__', '');
      const newPrice = parseFloat(text.replace(/[^\d.]/g, ''));
      if (isNaN(newPrice) || newPrice <= 0) {
        await setReplyWaiting(telegramId, replyCtx);
        return;
      }
      await supabaseAdmin.from('tender_orders')
        .update({ status: 'renegotiation', renegotiation_amount: newPrice })
        .eq('id', orderId);
      return;
    }

    await saveAndNotify(replyCtx.orderId, replyCtx.orderToken, driver.id, text);
    // Показываем кнопку "Написать ещё" — одно короткое сообщение без текста подтверждения
    const keyboard = new InlineKeyboard().text(
      lang === 'ka' ? '💬 კვლავ დაწერა' : lang === 'en' ? '💬 Write again' : '💬 Написать ещё',
      `msg_client:${replyCtx.orderId}`
    );
    await bot.api.sendMessage(telegramId, '✅', { reply_markup: keyboard });
    return;
  }

  // ─── AI-советник (обычное сообщение зарегистрированного исполнителя) ──────
  const { data: activeBids } = await supabaseAdmin
    .from('tender_bids')
    .select('order_id, tender_orders(id, token, cargo_description, localized_description, status)')
    .eq('driver_id', driver.id)
    .in('status', ['pending', 'winner'])
    .limit(5);

  const activeOrders = (activeBids ?? [])
    .map(b => Array.isArray(b.tender_orders) ? b.tender_orders[0] : b.tender_orders)
    .filter(o => o && ['bidding', 'selected', 'in_progress'].includes((o as Record<string, string>).status));

  if (activeOrders.length === 0) {
    const msgs: Record<string, string> = {
      ru: '📭 У вас нет активных заказов. Ожидайте новых заявок.',
      ka: '📭 თქვენ არ გაქვთ აქტიური შეკვეთები. დაელოდეთ ახალ განაცხადებს.',
      en: '📭 You have no active orders. Wait for new requests.',
    };
    await ctx.reply(msgs[lang] ?? msgs.ru);
    return;
  }

  if (activeOrders.length === 1) {
    const order = activeOrders[0] as Record<string, string>;
    await supabaseAdmin.from('tender_drivers').update({ active_order_id: order.id }).eq('id', driver.id);
    await handleDriverMessage(ctx, driver, order.id, text, lang);
    return;
  }

  // Несколько заказов — спрашиваем к какому относится сообщение
  // Store pending text in DB (no in-memory Map)
  await supabaseAdmin.from('tender_drivers').update({ pending_message: text }).eq('id', driver.id);

  const localized = (o: Record<string, unknown>) => {
    const ld = o.localized_description as Record<string, string> | null;
    return ld?.[lang] ?? (ld as Record<string, string> | null)?.ru ?? (o.cargo_description as string) ?? 'Заказ';
  };

  const keyboard = new InlineKeyboard();
  for (const order of activeOrders) {
    if (!order) continue;
    const o = order as Record<string, unknown>;
    const label = localized(o).slice(0, 40);
    keyboard.row().text(`📦 ${label}`, `select_order:${(o as Record<string, string>).id}`);
  }

  const prompts: Record<string, string> = {
    ru: '📋 К какому заказу относится ваше сообщение?',
    ka: '📋 რომელ შეკვეთას ეხება თქვენი შეტყობინება?',
    en: '📋 Which order does your message refer to?',
  };
  await ctx.reply(prompts[lang] ?? prompts.ru, { reply_markup: keyboard });
});

// ─── Получение контакта (кнопка "Поделиться контактом") ──────────────────────

bot.on('message:contact', async (ctx) => {
  const telegramId = ctx.from!.id;
  const { data: driver } = await supabaseAdmin
    .from('tender_drivers')
    .select('id, reg_state')
    .eq('telegram_id', telegramId)
    .single();

  if (!driver?.reg_state) return;
  const state = driver.reg_state as Record<string, string>;
  if (state.step !== 'phone') return;

  const raw = ctx.message.contact.phone_number.replace(/\s+/g, '');
  const normalized = normalizePhone(raw);
  if (!normalized) {
    await ctx.reply('Не удалось распознать номер. Введите вручную в формате +995XXXXXXXXX');
    return;
  }

  await proceedWithPhone(ctx, driver.id, state, normalized);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, '');
  const withPlus = digits.startsWith('+') ? digits : `+${digits}`;
  return /^\+\d{9,15}$/.test(withPlus) ? withPlus : null;
}

async function proceedWithPhone(ctx: Context, driverId: string, state: Record<string, string>, phone: string) {
  const { data: byPhone } = await supabaseAdmin
    .from('tender_drivers')
    .select('id')
    .eq('phone', phone)
    .neq('id', driverId)
    .single();

  if (byPhone) {
    await ctx.reply('Этот номер уже зарегистрирован. Обратитесь к администратору.', {
      reply_markup: { remove_keyboard: true },
    });
    await supabaseAdmin.from('tender_drivers').update({ reg_state: null }).eq('id', driverId);
    return;
  }

  await supabaseAdmin.from('tender_drivers').update({
    reg_state: { step: 'lang', name: state.name, phone },
    phone,
  }).eq('id', driverId);

  await ctx.reply('✅ Номер принят!', { reply_markup: { remove_keyboard: true } });

  const langKeyboard = new InlineKeyboard()
    .text('🇬🇪 ქართული', 'reg_lang:ka')
    .text('🇷🇺 Русский', 'reg_lang:ru')
    .text('🇬🇧 English', 'reg_lang:en');

  await ctx.reply('Выберите язык / აირჩიეთ ენა / Choose language:', { reply_markup: langKeyboard });
}

// ─── Callback: выбор языка → выбор специализации ─────────────────────────────

bot.callbackQuery(/^reg_lang:(.+)$/, async (ctx) => {
  const telegramId = ctx.from!.id;
  const lang = ctx.match[1];

  const { data: driver } = await supabaseAdmin
    .from('tender_drivers')
    .select('id, reg_state')
    .eq('telegram_id', telegramId)
    .single();

  if (!driver?.reg_state || (driver.reg_state as Record<string, string>).step !== 'lang') {
    await ctx.answerCallbackQuery();
    return;
  }

  const state = driver.reg_state as Record<string, string>;
  await supabaseAdmin.from('tender_drivers').update({
    reg_state: { step: 'spec', name: state.name, phone: state.phone, lang },
    driver_language: lang,
  }).eq('id', driver.id);

  await ctx.answerCallbackQuery();

  const keyboard = new InlineKeyboard()
    .text('🚛 Грузчик', 'reg_spec:mover')
    .row()
    .text('🚐 Водитель', 'reg_spec:driver')
    .row()
    .text('🔧 Разнорабочий', 'reg_spec:handyman');

  await ctx.editMessageText('Выберите вашу специализацию:', { reply_markup: keyboard });
});

// ─── Callback: выбор специализации → запись в БД ─────────────────────────────

bot.callbackQuery(/^reg_spec:(.+)$/, async (ctx) => {
  const telegramId = ctx.from!.id;
  const spec = ctx.match[1];

  const { data: driver } = await supabaseAdmin
    .from('tender_drivers')
    .select('id, reg_state')
    .eq('telegram_id', telegramId)
    .single();

  if (!driver?.reg_state) {
    await ctx.answerCallbackQuery({ text: 'Сессия истекла. Введите /start' });
    return;
  }

  const state = driver.reg_state as Record<string, string>;
  if (state.step !== 'spec' || !state.name || !state.phone || !state.lang) {
    await ctx.answerCallbackQuery({ text: 'Сессия истекла. Введите /start' });
    return;
  }

  await ctx.answerCallbackQuery();
  await ctx.editMessageText('⏳ Сохраняем данные...');

  const { error } = await supabaseAdmin.from('tender_drivers').update({
    name: state.name,
    phone: state.phone,
    driver_language: state.lang,
    specialization: spec,
    status: 'pending',
    reg_state: null,
  }).eq('id', driver.id);

  if (error) {
    await ctx.editMessageText(`❌ Ошибка при регистрации.\n\nКод: ${error.code}\n${error.message}`);
    return;
  }

  await ctx.editMessageText(
    `✅ ${state.name}, вы зарегистрированы!\n\n` +
    `⏳ Ваша заявка отправлена администратору. После подтверждения вы начнёте получать заказы.\n\n` +
    `📞 Телефон: ${state.phone}`
  );

  if (ADMIN_TELEGRAM_ID) {
    const specLabels: Record<string, string> = {
      mover: '🚛 Грузчик', driver: '🚐 Водитель', handyman: '🔧 Разнорабочий',
    };
    const adminKeyboard = new InlineKeyboard()
      .text('✅ Подтвердить', `admin_approve:${state.phone}`)
      .text('❌ Отклонить', `admin_reject:${state.phone}`);

    await bot.api.sendMessage(
      ADMIN_TELEGRAM_ID,
      `🆕 Новый исполнитель ожидает подтверждения\n\n` +
      `👤 Имя: ${state.name}\n📞 Телефон: ${state.phone}\n💼 Специализация: ${specLabels[spec] ?? spec}\n🌐 Язык: ${state.lang}`,
      { reply_markup: adminKeyboard }
    );
  }
});

// ─── Кнопки админа ───────────────────────────────────────────────────────────

bot.callbackQuery(/^admin_approve:(.+)$/, async (ctx) => {
  if (ADMIN_TELEGRAM_ID && ctx.from!.id !== ADMIN_TELEGRAM_ID) {
    await ctx.answerCallbackQuery({ text: '⛔ Нет прав' });
    return;
  }

  const phone = ctx.match[1];
  const { data: driver, error } = await supabaseAdmin
    .from('tender_drivers')
    .update({ status: 'active' })
    .eq('phone', phone)
    .eq('status', 'pending')
    .select('id, name, telegram_id')
    .single();

  if (error || !driver) {
    await ctx.answerCallbackQuery({ text: 'Не найден или уже активен', show_alert: true });
    return;
  }

  await ctx.answerCallbackQuery({ text: `✅ ${driver.name} подтверждён!` });
  await ctx.editMessageText((ctx.callbackQuery.message?.text ?? '') + `\n\n✅ Подтверждён`);

  if (driver.telegram_id) {
    await bot.api.sendMessage(
      driver.telegram_id,
      `✅ Ваш аккаунт подтверждён!\n\nТеперь вы будете получать новые заказы. Удачи! 🚀`
    );
  }
});

bot.callbackQuery(/^admin_reject:(.+)$/, async (ctx) => {
  if (ADMIN_TELEGRAM_ID && ctx.from!.id !== ADMIN_TELEGRAM_ID) {
    await ctx.answerCallbackQuery({ text: '⛔ Нет прав' });
    return;
  }

  const phone = ctx.match[1];
  const { data: driver } = await supabaseAdmin
    .from('tender_drivers')
    .update({ status: 'rejected' })
    .eq('phone', phone)
    .select('id, name, telegram_id')
    .single();

  await ctx.answerCallbackQuery({ text: 'Отклонено' });
  await ctx.editMessageText((ctx.callbackQuery.message?.text ?? '') + `\n\n❌ Отклонён`);

  if (driver?.telegram_id) {
    await bot.api.sendMessage(driver.telegram_id, `❌ К сожалению, ваша заявка отклонена. Обратитесь к менеджеру для уточнения.`);
  }
});

// ─── /approve ─────────────────────────────────────────────────────────────────

bot.command('approve', async (ctx) => {
  if (ADMIN_TELEGRAM_ID && ctx.from!.id !== ADMIN_TELEGRAM_ID) {
    await ctx.reply('⛔ У вас нет прав для этой команды.');
    return;
  }

  const phone = ctx.match.trim();
  if (!phone) { await ctx.reply('Формат: /approve +995599123456'); return; }

  const { data: driver, error } = await supabaseAdmin
    .from('tender_drivers')
    .update({ status: 'active' })
    .eq('phone', phone)
    .eq('status', 'pending')
    .select('id, name, telegram_id')
    .single();

  if (error || !driver) {
    await ctx.reply(`❌ Исполнитель с номером ${phone} не найден или уже активен.`);
    return;
  }

  await ctx.reply(`✅ ${driver.name} (${phone}) подтверждён и теперь получает заказы.`);

  if (driver.telegram_id) {
    await bot.api.sendMessage(driver.telegram_id, `✅ Ваш аккаунт подтверждён!\n\nТеперь вы будете получать новые заказы. Удачи! 🚀`);
  }
});

// ─── Обработка callback-кнопок ────────────────────────────────────────────────

bot.on('callback_query:data', async (ctx) => {
  const data = ctx.callbackQuery.data;

  if (data.startsWith('bid:'))          { await handleBid(ctx); return; }
  if (data.startsWith('withdraw:'))     { await handleWithdraw(ctx); return; }
  if (data.startsWith('renegotiate:'))  { await handleRenegotiate(ctx); return; }
  if (data.startsWith('offer:'))        { await handleOfferPrompt(ctx); return; }
  if (data.startsWith('ask_question:')) { await handleAskQuestion(ctx, data.slice('ask_question:'.length)); return; }
  if (data.startsWith('cancel:'))       { await handleCancel(ctx, data.slice('cancel:'.length)); return; }
  if (data.startsWith('select_order:')) return;

  if (data.startsWith('msg_client:')) { await handleMsgClient(ctx, data.slice('msg_client:'.length)); return; }
  if (data.startsWith('complete_order:')) { await handleCompleteOrder(ctx, data.slice('complete_order:'.length)); return; }
  if (data.startsWith('sos_order:')) { await handleSosOrder(ctx, data.slice('sos_order:'.length)); return; }
  if (data.startsWith('request_contact:')) { await handleRequestContact(ctx, data.slice('request_contact:'.length)); return; }
  if (data.startsWith('set_meeting:')) { await handleSetMeeting(ctx, data.slice('set_meeting:'.length)); return; }
  if (data.startsWith('confirm_meeting:')) { await handleConfirmMeeting(ctx, data.slice('confirm_meeting:'.length)); return; }
  if (data.startsWith('decline_meeting:')) { await handleDeclineMeeting(ctx, data.slice('decline_meeting:'.length)); return; }

  await ctx.answerCallbackQuery();
});

// ─── Ставка фиксированной суммой ─────────────────────────────────────────────

async function handleBid(ctx: Context) {
  const parts = ctx.callbackQuery!.data!.split(':');
  if (parts.length !== 3) { await ctx.answerCallbackQuery({ text: 'Ошибка формата ставки' }); return; }

  const [, orderId, amountStr] = parts;
  const amount = parseFloat(amountStr);
  if (isNaN(amount) || amount <= 0) { await ctx.answerCallbackQuery({ text: 'Некорректная сумма' }); return; }

  const { data: driver } = await supabaseAdmin
    .from('tender_drivers').select('id').eq('telegram_id', ctx.from!.id).single();
  if (!driver) { await ctx.answerCallbackQuery({ text: 'Вы не зарегистрированы. Введите /start' }); return; }

  await supabaseAdmin.from('tender_drivers').update({ active_order_id: orderId }).eq('id', driver.id);

  const { data: order } = await supabaseAdmin
    .from('tender_orders').select('status').eq('id', orderId).single();
  if (!order || order.status !== 'bidding') {
    await ctx.answerCallbackQuery({ text: 'Тендер уже закрыт', show_alert: true });
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
    return;
  }

  const msgId = ctx.callbackQuery!.message?.message_id ?? null;
  await supabaseAdmin.from('tender_bids').upsert(
    { order_id: orderId, driver_id: driver.id, amount, status: 'pending',
      bot_state: 'idle', bot_state_updated_at: new Date().toISOString(),
      telegram_message_id: msgId },
    { onConflict: 'order_id,driver_id' }
  );

  await ctx.answerCallbackQuery({ text: `Ставка ${amount} ₾ принята!` });
  if (msgId) await refreshCard(ctx.from!.id, msgId, orderId);
}

// ─── Отозвать ставку ──────────────────────────────────────────────────────────

async function handleWithdraw(ctx: Context) {
  const orderId = ctx.callbackQuery!.data!.split(':')[1];
  const { data: driver } = await supabaseAdmin
    .from('tender_drivers').select('id').eq('telegram_id', ctx.from!.id).single();
  if (!driver) { await ctx.answerCallbackQuery(); return; }

  await supabaseAdmin.from('tender_bids')
    .update({ status: 'withdrawn', bot_state: 'idle' })
    .eq('order_id', orderId).eq('driver_id', driver.id);

  await ctx.answerCallbackQuery({ text: 'Ставка отозвана.' });
  const msgId = ctx.callbackQuery!.message?.message_id;
  if (msgId) await refreshCard(ctx.from!.id, msgId, orderId);
}

// ─── Пересмотр цены (renegotiate) ────────────────────────────────────────────

async function handleRenegotiate(ctx: Context) {
  const orderId = ctx.callbackQuery!.data!.split(':')[1];
  const msgId = ctx.callbackQuery!.message?.message_id ?? null;
  await ctx.answerCallbackQuery();

  const { data: driver } = await supabaseAdmin
    .from('tender_drivers').select('id').eq('telegram_id', ctx.from!.id).single();
  if (driver) {
    await supabaseAdmin.from('tender_bids').update({
      bot_state: 'bidding', bot_state_updated_at: new Date().toISOString(),
      telegram_message_id: msgId,
    }).eq('order_id', orderId).eq('driver_id', driver.id);
  }

  if (msgId) await refreshCard(ctx.from!.id, msgId, orderId);
}

// ─── Своя цена (offer) ────────────────────────────────────────────────────────

async function handleOfferPrompt(ctx: Context) {
  const orderId = ctx.callbackQuery!.data!.split(':')[1];
  const messageId = ctx.callbackQuery!.message?.message_id ?? null;
  await ctx.answerCallbackQuery();

  const { data: driver } = await supabaseAdmin
    .from('tender_drivers').select('id').eq('telegram_id', ctx.from!.id).single();
  if (!driver) return;

  await supabaseAdmin.from('tender_bids').upsert(
    {
      order_id: orderId,
      driver_id: driver.id,
      amount: 0,
      status: 'pending',
      bot_state: 'bidding',
      bot_state_updated_at: new Date().toISOString(),
      telegram_message_id: messageId,
    },
    { onConflict: 'order_id,driver_id' }
  );

  if (messageId) await refreshCard(ctx.from!.id, messageId, orderId);
}

// ─── Задать вопрос клиенту ────────────────────────────────────────────────────

async function handleAskQuestion(ctx: Context, orderId: string) {
  await ctx.answerCallbackQuery();

  const { data: driver } = await supabaseAdmin
    .from('tender_drivers').select('id, driver_language, status').eq('telegram_id', ctx.from!.id).single();
  if (!driver || driver.status !== 'active') return;

  const { data: order } = await supabaseAdmin
    .from('tender_orders').select('status').eq('id', orderId).single();
  if (!order || !['bidding', 'selected'].includes(order.status)) {
    const lang = driver.driver_language ?? 'ru';
    const msgs: Record<string, string> = {
      ru: '❌ Заказ закрыт для вопросов.',
      ka: '❌ შეკვეთა დახურულია კითხვებისთვის.',
      en: '❌ Order is closed for questions.',
    };
    await ctx.reply(msgs[lang] ?? msgs.ru);
    return;
  }

  const messageId = ctx.callbackQuery?.message?.message_id ?? null;

  await supabaseAdmin.from('tender_bids').upsert(
    {
      order_id: orderId,
      driver_id: driver.id,
      amount: 0,
      status: 'pending',
      bot_state: 'asking',
      bot_state_updated_at: new Date().toISOString(),
      telegram_message_id: messageId,
    },
    { onConflict: 'order_id,driver_id' }
  );

  if (messageId) await refreshCard(ctx.from!.id, messageId, orderId);
}

// ─── Отмена (cancel) ─────────────────────────────────────────────────────────

async function handleCancel(ctx: Context, orderId: string) {
  await ctx.answerCallbackQuery();

  const { data: driver } = await supabaseAdmin
    .from('tender_drivers').select('id').eq('telegram_id', ctx.from!.id).single();
  if (!driver) return;

  await supabaseAdmin.from('tender_bids')
    .update({ bot_state: 'idle', bot_state_updated_at: new Date().toISOString() })
    .eq('order_id', orderId).eq('driver_id', driver.id);

  const msgId = ctx.callbackQuery!.message?.message_id;
  if (msgId) await refreshCard(ctx.from!.id, msgId, orderId);
}

// ─── 💬 Написать клиенту ─────────────────────────────────────────────────────

// ─── 💬 Написать клиенту ─────────────────────────────────────────────────────

async function handleMsgClient(ctx: Context, orderId: string) {
  console.log('[msg_client] orderId:', orderId, 'from:', ctx.from!.id);
  if (!orderId || orderId === 'undefined' || orderId === 'null') {
    await ctx.answerCallbackQuery({ text: 'Устаревшая кнопка', show_alert: true }); return;
  }
  const { data: driver } = await supabaseAdmin
    .from('tender_drivers').select('id, driver_language').eq('telegram_id', ctx.from!.id).single();
  if (!driver) { await ctx.answerCallbackQuery({ text: 'Профиль не найден', show_alert: true }); return; }

  const { data: order } = await supabaseAdmin
    .from('tender_orders').select('token').eq('id', orderId).single();
  if (!order) { await ctx.answerCallbackQuery({ text: 'Заказ не найден', show_alert: true }); return; }

  const lang = driver.driver_language ?? 'ru';
  const prompts: Record<string, string> = {
    ru: '✏️ Напишите сообщение клиенту:',
    ka: '✏️ დაწერეთ შეტყობინება კლიენტს:',
    en: '✏️ Type your message to the client:',
  };
  await ctx.answerCallbackQuery();
  const promptMsg = await ctx.reply(prompts[lang] ?? prompts.ru);
  await setReplyWaiting(ctx.from!.id, { orderId, orderToken: order.token, promptMessageId: promptMsg.message_id });
}

// ─── ✅ Завершить заказ ───────────────────────────────────────────────────────

async function handleCompleteOrder(ctx: Context, orderId: string) {
  if (!orderId || orderId === 'undefined') { await ctx.answerCallbackQuery({ text: 'Устаревшая кнопка', show_alert: true }); return; }
  await ctx.answerCallbackQuery();

  const { data: driver } = await supabaseAdmin
    .from('tender_drivers')
    .select('id, name, driver_language, completed_orders, total_earned')
    .eq('telegram_id', ctx.from!.id).single();
  if (!driver) return;

  const { data: order } = await supabaseAdmin
    .from('tender_orders').select('id, status').eq('id', orderId).eq('executor_id', driver.id).single();
  if (!order || order.status === 'completed') { await ctx.reply('Заказ уже завершён.'); return; }

  await supabaseAdmin.from('tender_orders').update({ status: 'completed' }).eq('id', orderId);

  const { data: bid } = await supabaseAdmin
    .from('tender_bids').select('amount').eq('order_id', orderId).eq('driver_id', driver.id).eq('status', 'winner').single();

  await supabaseAdmin.from('tender_drivers').update({
    completed_orders: (driver.completed_orders ?? 0) + 1,
    total_earned: (driver.total_earned ?? 0) + (bid?.amount ?? 0),
    active_order_id: null,
  }).eq('id', driver.id);

  const lang = driver.driver_language ?? 'ru';
  const msgs: Record<string, string> = {
    ru: `✅ Заказ завершён!\n\nОтличная работа, ${driver.name}! 💪\nЗаработано: ${bid?.amount ?? 0} ₾`,
    ka: `✅ შეკვეთა დასრულდა!\n\nშესანიშნავი სამუშაო, ${driver.name}! 💪\nგამომუშავებული: ${bid?.amount ?? 0} ₾`,
    en: `✅ Order completed!\n\nGreat work, ${driver.name}! 💪\nEarned: ${bid?.amount ?? 0} ₾`,
  };
  await ctx.editMessageText(msgs[lang] ?? msgs.ru, { reply_markup: { inline_keyboard: [] } });
}

// ─── ⚠️ Форс-мажор ───────────────────────────────────────────────────────────

async function handleSosOrder(ctx: Context, orderId: string) {
  if (!orderId || orderId === 'undefined') { await ctx.answerCallbackQuery({ text: 'Устаревшая кнопка', show_alert: true }); return; }
  await ctx.answerCallbackQuery();

  const { data: driver } = await supabaseAdmin
    .from('tender_drivers').select('id, driver_language').eq('telegram_id', ctx.from!.id).single();
  if (!driver) return;

  const lang = driver.driver_language ?? 'ru';
  const prompts: Record<string, string> = {
    ru: '⚠️ Укажите новую цену (только число, например: 250):',
    ka: '⚠️ მიუთითეთ ახალი ფასი (მხოლოდ რიცხვი, მაგ: 250):',
    en: '⚠️ Enter the new price (number only, e.g.: 250):',
  };
  const promptMsg = await ctx.reply(prompts[lang] ?? prompts.ru);
  await setReplyWaiting(ctx.from!.id, { orderId, orderToken: `__sos__${orderId}`, promptMessageId: promptMsg.message_id });
}

// ─── 📞 Запросить номер клиента ──────────────────────────────────────────────

async function handleRequestContact(ctx: Context, orderId: string) {
  if (!orderId || orderId === 'undefined') {
    await ctx.answerCallbackQuery({ text: 'Устаревшая кнопка', show_alert: true }); return;
  }

  const { data: driver } = await supabaseAdmin
    .from('tender_drivers').select('id, driver_language').eq('telegram_id', ctx.from!.id).single();
  if (!driver) { await ctx.answerCallbackQuery({ text: 'Профиль не найден', show_alert: true }); return; }

  // Проверяем что этот исполнитель победитель данного заказа
  const { data: bid } = await supabaseAdmin
    .from('tender_bids')
    .select('id, contact_shared, contact_requested')
    .eq('order_id', orderId)
    .eq('driver_id', driver.id)
    .eq('status', 'winner')
    .single();

  if (!bid) { await ctx.answerCallbackQuery({ text: 'Вы не победитель этого заказа', show_alert: true }); return; }

  if (bid.contact_shared) {
    // Контакт уже был передан — показываем снова из orders
    const { data: order } = await supabaseAdmin
      .from('tender_orders').select('client_phone, client_name').eq('id', orderId).single();
    const lang = driver.driver_language ?? 'ru';
    const msgs: Record<string, string> = {
      ru: `📞 Контакт клиента:\n👤 ${order?.client_name ?? 'Клиент'}\n📱 ${order?.client_phone ?? '—'}`,
      ka: `📞 კლიენტის კონტაქტი:\n👤 ${order?.client_name ?? 'კლიენტი'}\n📱 ${order?.client_phone ?? '—'}`,
      en: `📞 Client contact:\n👤 ${order?.client_name ?? 'Client'}\n📱 ${order?.client_phone ?? '—'}`,
    };
    await ctx.answerCallbackQuery();
    await ctx.reply(msgs[lang] ?? msgs.ru);
    return;
  }

  if (bid.contact_requested) {
    const lang = driver.driver_language ?? 'ru';
    const alreadyMsgs: Record<string, string> = {
      ru: '⏳ Запрос уже отправлен — ожидайте ответа клиента',
      ka: '⏳ მოთხოვნა უკვე გაგზავნილია — დაელოდეთ კლიენტის პასუხს',
      en: '⏳ Request already sent — waiting for client response',
    };
    await ctx.answerCallbackQuery({ text: alreadyMsgs[lang] ?? alreadyMsgs.ru, show_alert: true });
    return;
  }

  // Помечаем что запрос отправлен
  await supabaseAdmin.from('tender_bids').update({ contact_requested: true }).eq('id', bid.id);

  // Уведомляем клиента через WhatsApp
  const { data: order } = await supabaseAdmin
    .from('tender_orders').select('client_phone, token, push_subscription').eq('id', orderId).single();

  if (order) {
    const wappiToken = process.env.WAPPI_TOKEN;
    const wappiProfile = process.env.WAPPI_PROFILE_ID;
    if (wappiToken && wappiProfile && order.client_phone) {
      const url = `https://mushebi.ge/feed/${order.token}`;
      const text = `📞 Исполнитель хочет получить ваш номер телефона для связи.\n\nНажмите кнопку "Поделиться номером" здесь: ${url}`;
      await fetch(`https://wappi.pro/api/sync/message/send?profile_id=${wappiProfile}`, {
        method: 'POST',
        headers: { Authorization: wappiToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: text, recipient: order.client_phone.replace('+', '') }),
      }).catch(err => console.error('[request_contact whatsapp]', err));
    }
    // Push уведомление клиенту
    if (order.push_subscription && order.token) {
      const { sendPush } = await import('@/lib/push');
      await sendPush(order.push_subscription as Parameters<typeof sendPush>[0], {
        title: '📞 Исполнитель запрашивает ваш номер',
        body: 'Нажмите чтобы поделиться контактом',
        url: `/feed/${order.token}`,
      }).catch(() => {});
    }
  }

  const lang = driver.driver_language ?? 'ru';
  const sentMsgs: Record<string, string> = {
    ru: '✅ Запрос отправлен — клиент получит уведомление',
    ka: '✅ მოთხოვნა გაგზავნილია — კლიენტი მიიღებს შეტყობინებას',
    en: '✅ Request sent — client will be notified',
  };
  await ctx.answerCallbackQuery({ text: sentMsgs[lang] ?? sentMsgs.ru, show_alert: true });
}

// ─── 📅 Указать время встречи ────────────────────────────────────────────────

async function handleSetMeeting(ctx: Context, orderId: string) {
  if (!orderId || orderId === 'undefined') {
    await ctx.answerCallbackQuery({ text: 'Устаревшая кнопка', show_alert: true }); return;
  }
  const { data: driver } = await supabaseAdmin
    .from('tender_drivers').select('id, driver_language').eq('telegram_id', ctx.from!.id).single();
  if (!driver) { await ctx.answerCallbackQuery({ text: 'Профиль не найден', show_alert: true }); return; }

  const lang = (driver.driver_language ?? 'ru') as string;
  const prompts: Record<string, string> = {
    ru: '📅 Введите время когда будете у клиента:\nПримеры: "14:00", "завтра 10:00", "через 2 часа"',
    ka: '📅 შეიყვანეთ დრო, როდის მიხვალთ კლიენტთან:\nმაგ: "14:00", "ხვალ 10:00"',
    en: '📅 Enter the time when you will arrive:\nExamples: "14:00", "tomorrow 10:00", "in 2 hours"',
  };
  await ctx.answerCallbackQuery();
  const promptMsg = await ctx.reply(prompts[lang] ?? prompts.ru);
  await setReplyWaiting(ctx.from!.id, {
    orderId,
    orderToken: `__meeting__${orderId}`,
    promptMessageId: promptMsg.message_id,
    type: 'meeting_time',
  });
}

// ─── ✅ Клиент подтвердил встречу (через Telegram deep-link или кнопку) ───────

async function handleConfirmMeeting(ctx: Context, orderId: string) {
  await ctx.answerCallbackQuery({ text: '✅ Встреча подтверждена!', show_alert: true });

  await supabaseAdmin
    .from('tender_orders')
    .update({ meeting_confirmed: true })
    .eq('id', orderId);

  // Уведомляем исполнителя
  const { data: order } = await supabaseAdmin
    .from('tender_orders')
    .select('executor_id, meeting_time, order_number')
    .eq('id', orderId).single();

  if (order?.executor_id) {
    const { data: driver } = await supabaseAdmin
      .from('tender_drivers').select('telegram_id, driver_language').eq('id', order.executor_id).single();
    if (driver?.telegram_id) {
      const lang = (driver.driver_language ?? 'ru') as string;
      const time = order.meeting_time ? formatMeetingTime(new Date(order.meeting_time), lang) : '—';
      const msgs: Record<string, string> = {
        ru: `✅ Клиент подтвердил встречу!\n\n📅 Время: ${time}\n\nУдачи на заказе #${order.order_number}!`,
        ka: `✅ კლიენტმა შეხვედრა დაადასტურა!\n\n📅 დრო: ${time}\n\nწარმატება შეკვეთა #${order.order_number}-ზე!`,
        en: `✅ Client confirmed the meeting!\n\n📅 Time: ${time}\n\nGood luck on order #${order.order_number}!`,
      };
      await bot.api.sendMessage(Number(driver.telegram_id), msgs[lang] ?? msgs.ru).catch(() => {});
    }
  }
}

// ─── ❌ Клиент отклонил встречу ───────────────────────────────────────────────

async function handleDeclineMeeting(ctx: Context, orderId: string) {
  await ctx.answerCallbackQuery({ text: '❌ Вы отклонили встречу', show_alert: true });

  // Возвращаем в bidding — предлагаем следующего
  await supabaseAdmin
    .from('tender_orders')
    .update({ status: 'bidding', winning_bid_id: null, executor_id: null, meeting_time: null })
    .eq('id', orderId);

  const { data: winBid } = await supabaseAdmin
    .from('tender_bids')
    .select('id, driver_id')
    .eq('order_id', orderId)
    .eq('status', 'winner')
    .single();

  if (winBid) {
    await supabaseAdmin.from('tender_bids')
      .update({ status: 'lost', bot_state: 'closed' })
      .eq('id', winBid.id);

    // Уведомляем исполнителя
    const { data: driver } = await supabaseAdmin
      .from('tender_drivers').select('telegram_id, driver_language').eq('id', winBid.driver_id).single();
    if (driver?.telegram_id) {
      const lang = (driver.driver_language ?? 'ru') as string;
      const msgs: Record<string, string> = {
        ru: '😔 Клиент не смог подтвердить встречу. Заказ возвращён в торги.',
        ka: '😔 კლიენტმა ვერ დაადასტურა შეხვედრა. შეკვეთა ხელახლა გამოვიდა.',
        en: '😔 Client could not confirm the meeting. Order returned to bidding.',
      };
      await bot.api.sendMessage(Number(driver.telegram_id), msgs[lang] ?? msgs.ru).catch(() => {});
    }
  }

  // Предлагаем следующего по цене
  const { data: nextBid } = await supabaseAdmin
    .from('tender_bids')
    .select('id, driver_id, amount, tender_drivers(telegram_id, driver_language, name)')
    .eq('order_id', orderId)
    .eq('status', 'pending')
    .gt('amount', 0)
    .order('amount', { ascending: true })
    .limit(1)
    .single();

  if (nextBid) {
    const nextDriver = nextBid.tender_drivers as unknown as { telegram_id: number; driver_language: string; name: string } | null;
    if (nextDriver?.telegram_id) {
      const lang = (nextDriver.driver_language ?? 'ru') as string;
      const msgs: Record<string, string> = {
        ru: `🔔 Появилась возможность! Клиент снова выбирает исполнителя по вашему заказу. Ваша ставка: ${nextBid.amount} ₾`,
        ka: `🔔 შანსი გაჩნდა! კლიენტი კვლავ ირჩევს შემსრულებელს. თქვენი შეთავაზება: ${nextBid.amount} ₾`,
        en: `🔔 Opportunity! Client is choosing again. Your bid: ${nextBid.amount} ₾`,
      };
      await bot.api.sendMessage(Number(nextDriver.telegram_id), msgs[lang] ?? msgs.ru).catch(() => {});
    }
  }
}

// ─── Вспомогательные функции времени ─────────────────────────────────────────

function parseMeetingTime(text: string): Date | null {
  const now = new Date();
  const tbilisi = (d: Date) => new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Tbilisi' }));
  const t = text.trim().toLowerCase();

  // "14:00" или "14:30"
  const timeMatch = t.match(/^(\d{1,2}):(\d{2})$/);
  if (timeMatch) {
    const d = tbilisi(now);
    d.setHours(parseInt(timeMatch[1]), parseInt(timeMatch[2]), 0, 0);
    if (d < now) d.setDate(d.getDate() + 1); // если время уже прошло — завтра
    return d;
  }

  // "завтра 10:00" / "ხვალ 10:00" / "tomorrow 10:00"
  const tomorrowMatch = t.match(/(?:завтра|ხვალ|tomorrow)\s+(\d{1,2}):(\d{2})/);
  if (tomorrowMatch) {
    const d = tbilisi(now);
    d.setDate(d.getDate() + 1);
    d.setHours(parseInt(tomorrowMatch[1]), parseInt(tomorrowMatch[2]), 0, 0);
    return d;
  }

  // "через 2 часа" / "через 30 минут"
  const inHoursMatch = t.match(/через\s+(\d+)\s+час/);
  if (inHoursMatch) {
    return new Date(now.getTime() + parseInt(inHoursMatch[1]) * 60 * 60 * 1000);
  }
  const inMinsMatch = t.match(/через\s+(\d+)\s+мин/);
  if (inMinsMatch) {
    return new Date(now.getTime() + parseInt(inMinsMatch[1]) * 60 * 1000);
  }

  // "in 2 hours"
  const inHoursEnMatch = t.match(/in\s+(\d+)\s+hour/);
  if (inHoursEnMatch) {
    return new Date(now.getTime() + parseInt(inHoursEnMatch[1]) * 60 * 60 * 1000);
  }

  return null;
}

function formatMeetingTime(date: Date, lang: string): string {
  const options: Intl.DateTimeFormatOptions = {
    timeZone: 'Asia/Tbilisi',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  };
  const locale = lang === 'ka' ? 'ka-GE' : lang === 'en' ? 'en-US' : 'ru-RU';
  return date.toLocaleString(locale, options);
}

// ─── Выбор заказа из списка ───────────────────────────────────────────────────

bot.callbackQuery(/^select_order:(.+)$/, async (ctx) => {
  const orderId = ctx.match[1];
  const telegramId = ctx.from!.id;
  await ctx.answerCallbackQuery();

  const { data: driver } = await supabaseAdmin
    .from('tender_drivers')
    .select('id, name, status, driver_language, pending_message')
    .eq('telegram_id', telegramId).single();
  if (!driver || driver.status !== 'active') return;

  await supabaseAdmin.from('tender_drivers').update({ active_order_id: orderId, pending_message: null }).eq('id', driver.id);

  const lang = driver.driver_language ?? 'ru';
  const pending = driver.pending_message as string | null;

  if (pending) {
    await ctx.editMessageText('✅ Заказ выбран. Обрабатываю...');
    await handleDriverMessage(ctx, driver, orderId, pending, lang);
  } else {
    const confirms: Record<string, string> = {
      ru: '✅ Заказ выбран. Теперь пишите — отвечу в контексте этого заказа.',
      ka: '✅ შეკვეთა არჩეულია. ახლა დაწერეთ — ვუპასუხებ ამ შეკვეთის კონტექსტში.',
      en: '✅ Order selected. Write your message — I\'ll reply in the context of this order.',
    };
    await ctx.editMessageText(confirms[lang] ?? confirms.ru);
  }
});

// ─── AI-советник исполнителя ──────────────────────────────────────────────────

async function handleDriverMessage(
  ctx: Context,
  driver: { id: string; name: string; driver_language: string | null },
  orderId: string,
  text: string,
  lang: string,
) {
  const thinking = await ctx.reply('🤔 ...');
  try {
    const reply = await chatWithAdvisor({
      role: 'driver',
      userId: driver.id,
      orderId,
      userMessage: text,
      userName: driver.name,
      lang,
    });
    await ctx.api.editMessageText(ctx.chat!.id, thinking.message_id, reply);
  } catch (err) {
    console.error('[driver advisor]', err);
    await ctx.api.editMessageText(ctx.chat!.id, thinking.message_id, '❌ Ошибка. Попробуйте ещё раз.');
  }
}

// ─── saveAndNotify (msg_client flow) ─────────────────────────────────────────

async function saveAndNotify(orderId: string, orderToken: string, driverId: string, text: string) {
  const { data: driver } = await supabaseAdmin
    .from('tender_drivers').select('driver_language').eq('id', driverId).single();
  const driverLang = (driver?.driver_language as 'ru' | 'ka' | 'en') ?? 'ru';
  const translatedText = await translateChatMessage(text, driverLang, 'ru').catch(() => text);

  const { error: insertError } = await supabaseAdmin.from('order_messages').insert({
    order_id: orderId, sender_role: 'driver', sender_id: driverId,
    text, translated_text: translatedText, sender_lang: driverLang,
  });
  if (insertError) {
    await supabaseAdmin.from('order_messages').insert({
      order_id: orderId, sender_role: 'driver', sender_id: driverId, text,
    });
  }

  const { data: order } = await supabaseAdmin
    .from('tender_orders').select('client_phone').eq('id', orderId).single();
  if (!order?.client_phone) return;

  const wappiToken = process.env.WAPPI_TOKEN;
  const wappiProfile = process.env.WAPPI_PROFILE_ID;
  if (!wappiToken || !wappiProfile) return;

  const url = `https://mushebi.ge/tender/order/${orderToken}`;
  const showOriginal = translatedText !== text;
  const msg =
    `💬 Исполнитель написал вам:\n\n"${translatedText}"` +
    (showOriginal ? `\n(ориг: "${text}")` : '') +
    `\n\nОткройте заказ: ${url}`;

  await fetch(`https://wappi.pro/api/sync/message/send?profile_id=${wappiProfile}`, {
    method: 'POST',
    headers: { Authorization: wappiToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: msg, recipient: order.client_phone.replace('+', '') }),
  }).catch(console.error);
}

// ─── Рассылка заказа всем активным исполнителям ───────────────────────────────

const BID_AMOUNTS = [100, 130, 150, 180];

const CATEGORY_TO_SPECS: Record<string, string[]> = {
  moving:      ['mover', 'driver', 'moving', 'handyman'],
  transport:   ['driver', 'mover', 'moving'],
  cleaning:    ['handyman', 'cleaner', 'cleaning'],
  repair:      ['handyman', 'electrician', 'plumber', 'repair'],
  electricity: ['electrician', 'handyman', 'electrical'],
  plumbing:    ['plumber', 'handyman', 'plumbing'],
  general:     ['mover', 'driver', 'handyman', 'electrician', 'plumber', 'cleaner', 'moving', 'cleaning', 'electrical', 'plumbing', 'repair'],
};

export async function sendTenderToDrivers(orderId: string): Promise<void> {
  const { data: order } = await supabaseAdmin
    .from('tender_orders')
    .select('id, order_number, token, cargo_description, localized_description, scheduled_at, notes, media_urls, status, category, client_budget')
    .eq('id', orderId)
    .single();
  if (!order) return;

  const category = (order.category as string) ?? 'general';
  const allowedSpecs = CATEGORY_TO_SPECS[category] ?? CATEGORY_TO_SPECS['general'];

  const { data: drivers } = await supabaseAdmin
    .from('tender_drivers')
    .select('id, telegram_id, name, driver_language, telegram_chat_id, specialization')
    .eq('status', 'active')
    .not('telegram_id', 'is', null);

  const filteredDrivers = (drivers ?? []).filter(
    (d) => !d.specialization || allowedSpecs.includes(d.specialization)
  );
  if (filteredDrivers.length === 0) return;

  const hasMedia = Array.isArray(order.media_urls) && order.media_urls.length > 0;

  for (const driver of filteredDrivers) {
    if (!driver.telegram_id) continue;
    try {
      const lang = (driver.driver_language ?? 'ru') as string;

      // Используем buildCard() — единственный источник правды
      const { text, keyboard } = buildCard(
        order as CardOrder,
        { id: driver.id, driver_language: lang, telegram_id: driver.telegram_id },
        null, // нет ставки при первой отправке
        [],
        [],
      );

      const mediaUrls = order.media_urls as string[] | null;
      const images = mediaUrls ? mediaUrls.filter(u => !u.match(/\.(mp4|mov|webm)$/i)) : [];
      const videos = mediaUrls ? mediaUrls.filter(u => u.match(/\.(mp4|mov|webm)$/i)) : [];

      // Сначала медиа (фото/видео), потом карточка с кнопками — отдельным сообщением
      if (images.length === 1) {
        await bot.api.sendPhoto(driver.telegram_id, images[0]).catch(() => {});
      } else if (images.length > 1) {
        await bot.api.sendMediaGroup(
          driver.telegram_id,
          images.slice(0, 10).map(url => ({ type: 'photo' as const, media: url }))
        ).catch(() => {});
      }
      for (const url of videos.slice(0, 3)) {
        await bot.api.sendVideo(driver.telegram_id, url).catch(() => {});
      }

      // Карточка всегда текстовая — без ограничения 1024 символа
      const sent = await bot.api.sendMessage(driver.telegram_id, text, { reply_markup: keyboard });

      if (!driver.telegram_chat_id) {
        await supabaseAdmin.from('tender_drivers').update({ telegram_chat_id: driver.telegram_id }).eq('id', driver.id);
      }

      await supabaseAdmin.from('tender_bids').upsert(
        {
          order_id: orderId,
          driver_id: driver.id,
          amount: 0,
          status: 'pending',
          bot_state: 'idle',
          bot_state_updated_at: new Date().toISOString(),
          telegram_message_id: sent.message_id,
          card_type: 'text',
        },
        { onConflict: 'order_id,driver_id' }
      );
    } catch (err) {
      console.error(`[sendTenderToDrivers] driver ${driver.id}:`, err);
    }
  }

  // Anti-Churn: если через 10 мин нет ставок — напоминаем исполнителям
  setTimeout(() => checkAndNudgeDrivers(orderId), 10 * 60 * 1000);
}

// ─── Anti-Churn ───────────────────────────────────────────────────────────────

async function checkAndNudgeDrivers(orderId: string): Promise<void> {
  const { data: bids } = await supabaseAdmin
    .from('tender_bids').select('id').eq('order_id', orderId).gt('amount', 0);
  if (bids && bids.length > 0) return;

  const { data: order } = await supabaseAdmin
    .from('tender_orders').select('token, cargo_description, status').eq('id', orderId).single();
  if (!order || order.status !== 'bidding') return;

  const { data: drivers } = await supabaseAdmin
    .from('tender_drivers').select('telegram_id, driver_language').eq('status', 'active').not('telegram_id', 'is', null);
  if (!drivers) return;

  const msgs: Record<string, string> = {
    ru: `🔔 Напоминание: есть новый заказ без предложений!\n\n📋 ${order.cargo_description ?? ''}\n\nБудьте первым → https://mushebi.ge/feed/${order.token}`,
    ka: `🔔 შეხსენება: ახალი შეკვეთა შეთავაზებების გარეშე!\n\n📋 ${order.cargo_description ?? ''}\n\nიყავი პირველი → https://mushebi.ge/feed/${order.token}`,
    en: `🔔 Reminder: new order with no bids yet!\n\n📋 ${order.cargo_description ?? ''}\n\nBe first → https://mushebi.ge/feed/${order.token}`,
  };

  for (const driver of drivers) {
    if (!driver.telegram_id) continue;
    const lang = driver.driver_language ?? 'ru';
    try { await bot.api.sendMessage(driver.telegram_id, msgs[lang] ?? msgs['ru']); } catch {}
  }
}
