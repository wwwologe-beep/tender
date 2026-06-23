import { Bot, Context, InlineKeyboard } from 'grammy';
import { supabaseAdmin } from '@/lib/supabase';
import { chatWithAdvisor } from '@/lib/ai-advisor';
import { translateChatMessage } from '@/lib/ai';
import { buildCard, refreshCard, type CardOrder, type CardDriver, type CardBid } from '@/lib/telegram/card';
import { TARIFF_PLANS, type TariffPlanId } from '@/lib/types';

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
    .select('id, name, status, driver_language, reg_state, subscription_expires_at')
    .eq('telegram_id', telegramId)
    .single();

  // Уже зарегистрирован и не в процессе регистрации
  if (existing && !existing.reg_state) {
    const lang = (existing.driver_language as string) ?? 'ru';
    const expiresAt = existing.subscription_expires_at as string | null;
    const isActive  = expiresAt && new Date(expiresAt) > new Date();

    const statusMsgs: Record<string, string> = {
      ru: existing.status === 'active'
        ? (isActive
          ? `✅ ${existing.name}, вы активны и получаете заказы.\n\nПодписка действует до: ${new Date(expiresAt!).toLocaleDateString('ru-RU')}`
          : `⚠️ ${existing.name}, аккаунт активен, но подписка истекла.\n\nДля получения заказов продлите подписку: /topup`)
        : `⏳ ${existing.name}, ваш аккаунт ожидает подтверждения администратора.`,
      ka: existing.status === 'active'
        ? (isActive
          ? `✅ ${existing.name}, თქვენ აქტიური ხართ და იღებთ შეკვეთებს.\n\nგამოწერა მოქმედებს: ${new Date(expiresAt!).toLocaleDateString('ka-GE')}-მდე`
          : `⚠️ ${existing.name}, ანგარიში აქტიურია, მაგრამ გამოწერა ამოიწურა.\n\nშეკვეთების მისაღებად განაახლეთ: /topup`)
        : `⏳ ${existing.name}, თქვენი ანგარიში ელოდება ადმინისტრატორის დადასტურებას.`,
      en: existing.status === 'active'
        ? (isActive
          ? `✅ ${existing.name}, you are active and receiving orders.\n\nSubscription active until: ${new Date(expiresAt!).toLocaleDateString('en-GB')}`
          : `⚠️ ${existing.name}, account is active but subscription expired.\n\nRenew to receive orders: /topup`)
        : `⏳ ${existing.name}, your account is pending admin confirmation.`,
    };
    await ctx.reply(statusMsgs[lang] ?? statusMsgs.ru);
    return;
  }

  // Создаём или сбрасываем запись — первый шаг теперь выбор языка
  if (existing) {
    await supabaseAdmin.from('tender_drivers')
      .update({ reg_state: { step: 'lang' } })
      .eq('id', existing.id);
  } else {
    await supabaseAdmin.from('tender_drivers').upsert(
      { telegram_id: telegramId, reg_state: { step: 'lang' }, status: 'registering', name: '', phone: '' },
      { onConflict: 'telegram_id' }
    );
  }

  // Определяем язык устройства пользователя для подсветки
  const userLangCode = ctx.from?.language_code ?? '';
  const suggestedLang = userLangCode.startsWith('ka') ? 'ka' : userLangCode.startsWith('en') ? 'en' : 'ru';

  const langKeyboard = new InlineKeyboard()
    .text(suggestedLang === 'ka' ? '✅ 🇬🇪 ქართული' : '🇬🇪 ქართული', 'reg_lang:ka').row()
    .text(suggestedLang === 'ru' ? '✅ 🇷🇺 Русский'  : '🇷🇺 Русский',  'reg_lang:ru').row()
    .text(suggestedLang === 'en' ? '✅ 🇬🇧 English'  : '🇬🇧 English',  'reg_lang:en');

  await ctx.reply(
    '👋 Добро пожаловать в mushebi.ge!\n\n🌐 Выберите язык интерфейса:\nაირჩიეთ ენა:\nChoose language:',
    { reply_markup: langKeyboard }
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

  if (regState?.step === 'lang' || regState?.step === 'spec') {
    // Эти шаги — только инлайн-кнопки
    const btnMsgs: Record<string, string> = {
      ru: 'Пожалуйста, нажмите одну из кнопок ниже 👇',
      ka: 'გთხოვთ, დააჭიროთ ქვემოთ მოცემულ ღილაკს 👇',
      en: 'Please use the buttons below 👇',
    };
    const btnLang = regState.lang ?? 'ru';
    await ctx.reply(btnMsgs[btnLang] ?? btnMsgs.ru);
    return;
  }

  if (regState?.step === 'name') {
    const btnLang = regState.lang ?? 'ru';
    const nameValid = /^[\p{L}\s]{2,50}$/u.test(text);
    if (!nameValid) {
      const errMsgs: Record<string, string> = {
        ru: 'Введите имя и фамилию (только буквы, 2–50 символов).\nПример: Георгий Иванов',
        ka: 'შეიყვანეთ სახელი და გვარი (მხოლოდ ასოები, 2–50 სიმბოლო).\nმაგ: გიორგი ივანოვი',
        en: 'Enter first and last name (letters only, 2–50 chars).\nExample: George Johnson',
      };
      await ctx.reply(errMsgs[btnLang] ?? errMsgs.ru);
      return;
    }
    await supabaseAdmin.from('tender_drivers').update({
      reg_state: { step: 'phone', lang: btnLang, name: text },
      name: text,
    }).eq('id', driver.id);

    const phoneMsgs: Record<string, string> = {
      ru: `✅ Отлично, ${text}!\n\nТеперь поделитесь номером телефона — нажмите кнопку ниже:`,
      ka: `✅ მშვენიერია, ${text}!\n\nახლა გაუზიარეთ ტელეფონის ნომერი — დააჭირეთ ქვემოთ:`,
      en: `✅ Great, ${text}!\n\nNow share your phone number — tap the button below:`,
    };
    const shareBtn: Record<string, string> = { ru: '📱 Поделиться номером', ka: '📱 ნომრის გაზიარება', en: '📱 Share phone number' };
    await ctx.reply(phoneMsgs[btnLang] ?? phoneMsgs.ru, {
      reply_markup: {
        keyboard: [[{ text: shareBtn[btnLang] ?? shareBtn.ru, request_contact: true }]],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    });
    return;
  }

  if (regState?.step === 'phone') {
    // Водитель ввёл текст вместо нажатия кнопки — отклоняем, просим использовать кнопку
    const btnLang = regState.lang ?? 'ru';
    const errMsgs: Record<string, string> = {
      ru: '❗ Пожалуйста, используйте кнопку «📱 Поделиться номером» для передачи контакта.\n\nЭто защищает вас от ввода неверного номера.',
      ka: '❗ გთხოვთ გამოიყენოთ «📱 ნომრის გაზიარება» ღილაკი.\n\nეს იცავს არასწორი ნომრის შეყვანისგან.',
      en: '❗ Please use the «📱 Share phone number» button to share your contact.\n\nThis prevents entering an incorrect number.',
    };
    const shareBtn: Record<string, string> = { ru: '📱 Поделиться номером', ka: '📱 ნომრის გაზიარება', en: '📱 Share phone number' };
    await ctx.reply(errMsgs[btnLang] ?? errMsgs.ru, {
      reply_markup: {
        keyboard: [[{ text: shareBtn[btnLang] ?? shareBtn.ru, request_contact: true }]],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    });
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
    const lang = state.lang ?? 'ru';
    const errMsgs: Record<string, string> = {
      ru: '❌ Не удалось распознать номер. Попробуйте ещё раз.',
      ka: '❌ ნომრის ამოცნობა ვერ მოხდა. სცადეთ ისევ.',
      en: '❌ Could not parse number. Please try again.',
    };
    await ctx.reply(errMsgs[lang] ?? errMsgs.ru);
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
  const lang = state.lang ?? 'ru';

  const { data: byPhone } = await supabaseAdmin
    .from('tender_drivers')
    .select('id')
    .eq('phone', phone)
    .neq('id', driverId)
    .single();

  if (byPhone) {
    const dupMsgs: Record<string, string> = {
      ru: 'Этот номер уже зарегистрирован.\n\nЕсли это ваш — обратитесь к администратору.\nИначе введите /start и укажите другой номер.',
      ka: 'ეს ნომერი უკვე დარეგისტრირებულია.\n\nთუ ეს თქვენია — დაუკავშირდით ადმინისტრატორს.\nსხვაგვარად შეიყვანეთ /start და მიუთითეთ სხვა ნომერი.',
      en: 'This number is already registered.\n\nIf it\'s yours — contact the administrator.\nOtherwise type /start and use a different number.',
    };
    await ctx.reply(dupMsgs[lang] ?? dupMsgs.ru, { reply_markup: { remove_keyboard: true } });
    await supabaseAdmin.from('tender_drivers').delete().eq('id', driverId).eq('status', 'registering');
    return;
  }

  await supabaseAdmin.from('tender_drivers').update({
    reg_state: { step: 'spec', lang, name: state.name, phone },
    phone,
  }).eq('id', driverId);

  const acceptMsgs: Record<string, string> = {
    ru: '✅ Номер принят! Теперь выберите вашу специализацию:',
    ka: '✅ ნომერი მიღებულია! ახლა აირჩიეთ თქვენი სპეციალიზაცია:',
    en: '✅ Phone accepted! Now choose your specialization:',
  };
  await ctx.reply(acceptMsgs[lang] ?? acceptMsgs.ru, {
    reply_markup: { remove_keyboard: true },
  });
  await ctx.reply('👇', { reply_markup: buildSpecKeyboard(lang) });
}

// ─── Callback: выбор языка → запрос имени ────────────────────────────────────

bot.callbackQuery(/^reg_lang:(.+)$/, async (ctx) => {
  const telegramId = ctx.from!.id;
  const lang = ctx.match[1] as 'ru' | 'ka' | 'en';

  const { data: driver } = await supabaseAdmin
    .from('tender_drivers')
    .select('id, reg_state')
    .eq('telegram_id', telegramId)
    .single();

  if (!driver?.reg_state || (driver.reg_state as Record<string, string>).step !== 'lang') {
    await ctx.answerCallbackQuery();
    return;
  }

  await supabaseAdmin.from('tender_drivers').update({
    reg_state: { step: 'name', lang },
    driver_language: lang,
  }).eq('id', driver.id);

  await ctx.answerCallbackQuery();

  const nameMsgs: Record<string, string> = {
    ru: '✅ Язык выбран: Русский\n\nВведите ваше имя и фамилию:',
    ka: '✅ ენა არჩეულია: ქართული\n\nშეიყვანეთ თქვენი სახელი და გვარი:',
    en: '✅ Language selected: English\n\nEnter your first and last name:',
  };
  await ctx.editMessageText(nameMsgs[lang] ?? nameMsgs.ru);
});

// ─── Callback: промежуточный — reg_lang на шаге spec (показ специализаций) ────
// Triggered AFTER phone is confirmed — driver.reg_state.step === 'spec'

function buildSpecKeyboard(lang: string): InlineKeyboard {
  const labels: Record<string, Record<string, string>> = {
    ru: { mover: '🚛 Грузчик / переезды', driver: '🚐 Водитель / доставка', handyman: '🔧 Разнорабочий / мастер' },
    ka: { mover: '🚛 მეამბოხე / გადასვლები', driver: '🚐 მძღოლი / მიწოდება', handyman: '🔧 სამუშაო კაცი / ოსტატი' },
    en: { mover: '🚛 Mover / relocation', driver: '🚐 Driver / delivery', handyman: '🔧 Handyman / repairs' },
  };
  const l = labels[lang] ?? labels.ru;
  return new InlineKeyboard()
    .text(l.mover,    'reg_spec:mover').row()
    .text(l.driver,   'reg_spec:driver').row()
    .text(l.handyman, 'reg_spec:handyman');
}

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
  await ctx.editMessageText('⏳...');

  const { error } = await supabaseAdmin.from('tender_drivers').update({
    name:            state.name,
    phone:           state.phone,
    driver_language: state.lang,
    specialization:  spec,
    status:          'pending',
    reg_state:       null,
  }).eq('id', driver.id);

  if (error) {
    await ctx.editMessageText(`❌ Ошибка при регистрации.\n\nКод: ${error.code}\n${error.message}`);
    return;
  }

  const lang = state.lang;
  const doneMsgs: Record<string, string> = {
    ru: `✅ ${state.name}, заявка отправлена!\n\n⏳ Администратор проверит данные и активирует аккаунт в течение нескольких часов.\n\nПосле активации вы получите сообщение с инструкцией по оплате подписки.`,
    ka: `✅ ${state.name}, განაცხადი გაიგზავნა!\n\n⏳ ადმინისტრატორი შეამოწმებს მონაცემებს და გააქტიურებს ანგარიშს რამდენიმე საათში.\n\nგააქტიურების შემდეგ მიიღებთ გამოწერის გადახდის ინსტრუქციას.`,
    en: `✅ ${state.name}, application sent!\n\n⏳ Admin will review your details and activate your account within a few hours.\n\nAfter activation you will receive subscription payment instructions.`,
  };
  await ctx.editMessageText(doneMsgs[lang] ?? doneMsgs.ru);

  if (ADMIN_TELEGRAM_ID) {
    const specLabels: Record<string, string> = {
      mover: '🚛 Грузчик', driver: '🚐 Водитель', handyman: '🔧 Разнорабочий',
    };
    const adminKeyboard = new InlineKeyboard()
      .text('✅ Активировать',          `admin_approve:${state.phone}`).row()
      .text('🎁 Одобрить + 7 дней триала', `approve_with_trial:${driver.id}`).row()
      .text('❌ Отклонить',             `admin_reject:${state.phone}`);

    await bot.api.sendMessage(
      ADMIN_TELEGRAM_ID,
      `🆕 Новый исполнитель ожидает подтверждения\n\n` +
      `👤 Имя: ${state.name}\n📞 Телефон: ${state.phone}\n` +
      `💼 Специализация: ${specLabels[spec] ?? spec}\n🌐 Язык: ${lang}`,
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
    .select('id, name, telegram_id, driver_language')
    .single();

  if (error || !driver) {
    await ctx.answerCallbackQuery({ text: 'Не найден или уже активен', show_alert: true });
    return;
  }

  await ctx.answerCallbackQuery({ text: `✅ ${driver.name} активирован!` });
  await ctx.editMessageText((ctx.callbackQuery.message?.text ?? '') + `\n\n✅ Активирован`);

  if (driver.telegram_id) {
    const lang = (driver.driver_language as string) ?? 'ru';
    const code = `MUSH-${driver.id.slice(0, 5).toUpperCase()}`;

    // Шаг 1: поздравление с активацией
    const welcomeMsgs: Record<string, string> = {
      ru: `🎉 ${driver.name}, ваш аккаунт активирован!\n\nЧтобы начать получать заказы в Тбилиси и Батуми, подключите безлимитный недельный тариф — всего 30 ₾/неделю.`,
      ka: `🎉 ${driver.name}, თქვენი ანგარიში გააქტიურდა!\n\nთბილისსა და ბათუმში შეკვეთების მიღების დასაწყებად დაუკავშირდით ულიმიტო კვირის ტარიფს — მხოლოდ 30 ₾/კვირაში.`,
      en: `🎉 ${driver.name}, your account has been activated!\n\nTo start receiving orders in Tbilisi and Batumi, activate the unlimited weekly plan — just 30 ₾/week.`,
    };
    await bot.api.sendMessage(driver.telegram_id, welcomeMsgs[lang] ?? welcomeMsgs.ru);

    // Шаг 2: инструкция по оплате (та же логика что и /topup)
    const tariffList = TARIFF_PLANS.map(p => `• ${p.label} — ${p.price} ₾`).join('\n');
    const payMsgs: Record<string, string> = {
      ru: `💳 *Тарифы:*\n${tariffList}\n\n*Реквизиты для перевода:*\nIBAN: \`${PAYMENT_DETAILS}\`\n\n⚠️ Обязательно укажите код:\n*${code}*\n\nПосле оплаты отправьте скриншот чека в этот чат — оператор активирует подписку вручную.`,
      ka: `💳 *ტარიფები:*\n${tariffList}\n\n*გადახდის რეკვიზიტები:*\nIBAN: \`${PAYMENT_DETAILS}\`\n\n⚠️ აუცილებლად მიუთითეთ კოდი:\n*${code}*\n\nგადახდის შემდეგ გამოაგზავნეთ ქვითრის სკრინშოტი ამ ჩატში — ოპერატორი ხელით გააქტიურებს გამოწერას.`,
      en: `💳 *Plans:*\n${tariffList}\n\n*Payment details:*\nIBAN: \`${PAYMENT_DETAILS}\`\n\n⚠️ Include transfer code:\n*${code}*\n\nAfter payment, send a screenshot of the receipt here — operator will activate your subscription.`,
    };
    await bot.api.sendMessage(driver.telegram_id, payMsgs[lang] ?? payMsgs.ru, { parse_mode: 'Markdown' });
  }
});

bot.callbackQuery(/^approve_with_trial:(.+)$/, async (ctx) => {
  if (ADMIN_TELEGRAM_ID && ctx.from!.id !== ADMIN_TELEGRAM_ID) {
    await ctx.answerCallbackQuery({ text: '⛔ Нет прав' });
    return;
  }

  const driverId = ctx.match[1];
  const { data: driver, error } = await supabaseAdmin
    .from('tender_drivers')
    .update({ status: 'active' })
    .eq('id', driverId)
    .eq('status', 'pending')
    .select('id, name, telegram_id, driver_language')
    .single();

  if (error || !driver) {
    await ctx.answerCallbackQuery({ text: 'Не найден или уже активен', show_alert: true });
    return;
  }

  // Начисляем 7 дней безлимитного триала через RPC
  const { error: trialError } = await supabaseAdmin.rpc('extend_driver_subscription', {
    p_driver_id: driver.id,
    p_days:      7,
  });

  if (trialError) {
    console.error('[approve_with_trial] rpc error:', trialError.message);
    await ctx.answerCallbackQuery({
      text: `❌ Ошибка начисления триала: ${trialError.message}. Статус активирован, триал — нет. Добавьте вручную.`,
      show_alert: true,
    });
    return;
  }

  const operatorName = ctx.from!.first_name ?? 'Оператор';
  await ctx.answerCallbackQuery({ text: `🎁 ${driver.name} — 7 дней триала!` });
  await ctx.editMessageText(
    (ctx.callbackQuery.message?.text ?? '') +
    `\n\n🎁 Одобрен с 7-дневным ТРИАЛОМ оператором ${operatorName}`
  );

  if (driver.telegram_id) {
    const lang = (driver.driver_language as string) ?? 'ru';
    const trialMsgs: Record<string, string> = {
      ru: `🎉 Добро пожаловать в команду, ${driver.name}!\n\nВаш аккаунт успешно активирован. Администрация предоставила вам *7 дней БЕСПЛАТНОГО тестового периода!* 🚀\n\nВы уже можете принимать заказы в Тбилиси и Батуми — заходите и зарабатывайте!\n\nПосмотреть статус аккаунта: /profile`,
      ka: `🎉 კეთილი იყოს თქვენი მობრძანება გუნდში, ${driver.name}!\n\nთქვენი ანგარიში წარმატებით გააქტიურდა. ადმინისტრაცია გაძლევთ *7 დღიანი ᲣᲤᲐᲡᲝ საცდელი პერიოდი!* 🚀\n\nუკვე შეგიძლიათ მიიღოთ შეკვეთები თბილისსა და ბათუმში — შედით და იმუშავეთ!\n\nანგარიშის სტატუსი: /profile`,
      en: `🎉 Welcome to the team, ${driver.name}!\n\nYour account has been successfully activated. The administration has granted you a *7-day FREE trial period!* 🚀\n\nYou can already receive orders in Tbilisi and Batumi — dive in and start earning!\n\nCheck your account status: /profile`,
    };
    await bot.api.sendMessage(
      driver.telegram_id,
      trialMsgs[lang] ?? trialMsgs.ru,
      { parse_mode: 'Markdown' }
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
    .select('id, name, telegram_id, driver_language')
    .single();

  await ctx.answerCallbackQuery({ text: 'Отклонено' });
  await ctx.editMessageText((ctx.callbackQuery.message?.text ?? '') + `\n\n❌ Отклонён`);

  if (driver?.telegram_id) {
    const lang = (driver.driver_language as string) ?? 'ru';
    const rejectMsgs: Record<string, string> = {
      ru: '❌ К сожалению, ваша заявка отклонена. Обратитесь к менеджеру для уточнения.',
      ka: '❌ სამწუხაროდ, თქვენი განაცხადი უარყოფილია. დაუკავშირდით მენეჯერს დეტალებისთვის.',
      en: '❌ Unfortunately, your application has been rejected. Please contact the manager for details.',
    };
    await bot.api.sendMessage(driver.telegram_id, rejectMsgs[lang] ?? rejectMsgs.ru);
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

  // Компактный формат из очереди уведомлений: b:<token>:<price> и a:<token>
  if (data.startsWith('b:'))            { await handleBidByToken(ctx); return; }
  if (data.startsWith('a:'))            { await handleAcceptBudgetByToken(ctx); return; }
  if (data.startsWith('approve_sub:'))  { await handleApproveSubscription(ctx); return; }
  if (data.startsWith('reject_sub:'))   { await handleRejectSubscription(ctx); return; }
  if (data === 'topup')                 { await handleTopup(ctx); return; }

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

// ─── Компактный формат: b:<token>:<price> ────────────────────────────────────

async function handleBidByToken(ctx: Context) {
  const parts = ctx.callbackQuery!.data!.split(':');
  if (parts.length < 3) { await ctx.answerCallbackQuery({ text: 'Ошибка формата', show_alert: true }); return; }

  const [, orderToken, amountStr] = parts;
  const amount = parseFloat(amountStr);
  if (isNaN(amount) || amount <= 0) { await ctx.answerCallbackQuery({ text: 'Некорректная сумма', show_alert: true }); return; }

  const { data: driver } = await supabaseAdmin
    .from('tender_drivers')
    .select('id, status, driver_language, subscription_expires_at')
    .eq('telegram_id', ctx.from!.id)
    .single();
  if (!driver || driver.status !== 'active') {
    await ctx.answerCallbackQuery({ text: 'Водитель не зарегистрирован', show_alert: true }); return;
  }

  const lang = (driver.driver_language as string) ?? 'ru';

  const expiresAt = driver.subscription_expires_at as string | null;
  if (!expiresAt || new Date() > new Date(expiresAt)) {
    const noSubMsgs: Record<string, string> = {
      ru: '❌ Ваш безлимитный тариф не активен. Пожалуйста, продлите подписку у оператора.',
      ka: '❌ თქვენი ულიმიტო ტარიფი არ არის აქტიური. გთხოვთ, განაახლოთ გამოწერა ოპერატორთან.',
      en: '❌ Your unlimited plan is not active. Please renew your subscription with the operator.',
    };
    await ctx.answerCallbackQuery({ text: noSubMsgs[lang] ?? noSubMsgs.ru, show_alert: true });
    return;
  }

  const { data: order } = await supabaseAdmin
    .from('tender_orders').select('id, status').eq('token', orderToken).single();
  if (!order || order.status !== 'bidding') {
    await ctx.answerCallbackQuery({ text: 'Тендер уже закрыт', show_alert: true }); return;
  }

  await supabaseAdmin.from('tender_bids').upsert(
    { order_id: order.id, driver_id: driver.id, amount, status: 'pending',
      bot_state: 'idle', bot_state_updated_at: new Date().toISOString() },
    { onConflict: 'order_id,driver_id' }
  );

  const msgs: Record<string, string> = {
    ru: `✅ Ставка ${amount} ₾ принята!`,
    ka: `✅ განაცხადი ${amount} ₾ მიღებულია!`,
    en: `✅ Bid ${amount} ₾ accepted!`,
  };
  await ctx.answerCallbackQuery({ text: msgs[lang] ?? msgs.ru });
}

// ─── Компактный формат: a:<token> (принять бюджет) ───────────────────────────

async function handleAcceptBudgetByToken(ctx: Context) {
  const orderToken = ctx.callbackQuery!.data!.split(':')[1];
  if (!orderToken) { await ctx.answerCallbackQuery({ text: 'Ошибка формата', show_alert: true }); return; }

  const { data: driver } = await supabaseAdmin
    .from('tender_drivers')
    .select('id, status, driver_language, subscription_expires_at')
    .eq('telegram_id', ctx.from!.id)
    .single();
  if (!driver || driver.status !== 'active') {
    await ctx.answerCallbackQuery({ text: 'Водитель не зарегистрирован', show_alert: true }); return;
  }

  const lang = (driver.driver_language as string) ?? 'ru';

  const expiresAt = driver.subscription_expires_at as string | null;
  if (!expiresAt || new Date() > new Date(expiresAt)) {
    const noSubMsgs: Record<string, string> = {
      ru: '❌ Ваш безлимитный тариф не активен. Пожалуйста, продлите подписку у оператора.',
      ka: '❌ თქვენი ულიმიტო ტარიფი არ არის აქტიური. გთხოვთ, განაახლოთ გამოწერა ოპერატორთან.',
      en: '❌ Your unlimited plan is not active. Please renew your subscription with the operator.',
    };
    await ctx.answerCallbackQuery({ text: noSubMsgs[lang] ?? noSubMsgs.ru, show_alert: true });
    return;
  }

  const { data: order } = await supabaseAdmin
    .from('tender_orders').select('id, status, client_budget').eq('token', orderToken).single();
  if (!order || order.status !== 'bidding') {
    await ctx.answerCallbackQuery({ text: 'Тендер уже закрыт', show_alert: true }); return;
  }

  const amount = order.client_budget as number;
  if (!amount || amount <= 0) {
    await ctx.answerCallbackQuery({ text: 'Бюджет не задан клиентом', show_alert: true }); return;
  }

  await supabaseAdmin.from('tender_bids').upsert(
    { order_id: order.id, driver_id: driver.id, amount, status: 'pending',
      bot_state: 'idle', bot_state_updated_at: new Date().toISOString() },
    { onConflict: 'order_id,driver_id' }
  );

  const msgs: Record<string, string> = {
    ru: `✅ Принят бюджет клиента: ${amount} ₾`,
    ka: `✅ კლიენტის ბიუჯეტი: ${amount} ₾`,
    en: `✅ Accepted client budget: ${amount} ₾`,
  };
  await ctx.answerCallbackQuery({ text: msgs[lang] ?? msgs.ru });
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

  // Check if bid already exists (winner bid — don't reset amount/status)
  const { data: existingBid } = await supabaseAdmin
    .from('tender_bids')
    .select('id')
    .eq('order_id', orderId)
    .eq('driver_id', driver.id)
    .single();

  if (existingBid) {
    await supabaseAdmin.from('tender_bids').update({
      bot_state: 'asking',
      bot_state_updated_at: new Date().toISOString(),
      ...(messageId ? { telegram_message_id: messageId } : {}),
    }).eq('id', existingBid.id);
  } else {
    await supabaseAdmin.from('tender_bids').insert({
      order_id: orderId,
      driver_id: driver.id,
      amount: 0,
      status: 'pending',
      bot_state: 'asking',
      bot_state_updated_at: new Date().toISOString(),
      telegram_message_id: messageId,
    });
  }

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
    console.log('[request_contact] client_phone:', order.client_phone, 'wappiToken:', !!wappiToken, 'wappiProfile:', wappiProfile);
    if (wappiToken && wappiProfile && order.client_phone) {
      const url = `https://mushebi.ge/feed/${order.token}`;
      const text = `📞 Исполнитель хочет получить ваш номер телефона для связи.\n\nНажмите кнопку "Поделиться номером" здесь: ${url}`;
      const recipient = order.client_phone.replace('+', '').replace(/\s/g, '');
      console.log('[request_contact] sending to recipient:', recipient);
      const wappiRes = await fetch(`https://wappi.pro/api/sync/message/send?profile_id=${wappiProfile}`, {
        method: 'POST',
        headers: { Authorization: wappiToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: text, recipient }),
      }).catch(err => { console.error('[request_contact whatsapp fetch error]', err); return null; });
      if (wappiRes) {
        const wappiData = await wappiRes.json().catch(() => null);
        console.log('[request_contact] wappi response:', wappiRes.status, JSON.stringify(wappiData));
      }
    } else {
      console.warn('[request_contact] skipping WhatsApp — missing:', { wappiToken: !!wappiToken, wappiProfile: !!wappiProfile, client_phone: order.client_phone });
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

// ═══════════════════════════════════════════════════════════════════════════════
// ─── ФИНТЕХ: Подписки водителей ──────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID
  ? parseInt(process.env.TELEGRAM_ADMIN_CHAT_ID)
  : ADMIN_TELEGRAM_ID; // fallback на личку админа

// Реквизиты для оплаты (заглушка — заменить на реальные перед production)
const PAYMENT_DETAILS = 'GE00TB0000000000000000'; // IBAN-заглушка

// ─── /topup — запрос на пополнение ───────────────────────────────────────────

bot.command('topup', async (ctx) => {
  const telegramId = ctx.from!.id;

  const { data: driver } = await supabaseAdmin
    .from('tender_drivers')
    .select('id, name, status, driver_language, subscription_expires_at')
    .eq('telegram_id', telegramId)
    .maybeSingle();

  const notAllowed = !driver || driver.status === 'registering' || driver.status === 'blocked' || driver.status === 'rejected';
  if (notAllowed) {
    const errLang = (driver?.driver_language as string) ?? 'ru';
    const noAccessMsgs: Record<string, string> = {
      ru: !driver || driver.status === 'registering'
        ? 'Вы ещё не зарегистрированы. Введите /start'
        : '⛔ Ваш аккаунт заблокирован. Обратитесь к администратору.',
      ka: !driver || driver.status === 'registering'
        ? 'თქვენ ჯერ არ ხართ დარეგისტრირებული. შეიყვანეთ /start'
        : '⛔ თქვენი ანგარიში დაბლოკილია. დაუკავშირდით ადმინისტრატორს.',
      en: !driver || driver.status === 'registering'
        ? 'You are not registered yet. Type /start'
        : '⛔ Your account is blocked. Contact the administrator.',
    };
    await ctx.reply(noAccessMsgs[errLang] ?? noAccessMsgs.ru);
    return;
  }

  const lang = (driver.driver_language as string) ?? 'ru';
  const code = `MUSH-${driver.id.slice(0, 5).toUpperCase()}`;

  const tariffList = TARIFF_PLANS
    .map(p => `• ${p.label} — ${p.price} ₾`)
    .join('\n');

  const expiresAt = driver.subscription_expires_at as string | null;
  const subStatus = expiresAt && new Date(expiresAt) > new Date()
    ? `✅ Активна до: ${new Date(expiresAt).toLocaleDateString('ru-RU')}`
    : '❌ Не активна';

  const msgs: Record<string, string> = {
    ru: `💳 *Пополнение подписки*\n\nСтатус: ${subStatus}\n\n*Тарифы:*\n${tariffList}\n\n*Реквизиты для перевода:*\nIBAN: \`${PAYMENT_DETAILS}\`\n\n⚠️ Обязательно укажите код перевода:\n*${code}*\n\nПосле оплаты отправьте скриншот чека прямо сюда — оператор активирует подписку вручную.`,
    ka: `💳 *გამოწერის შევსება*\n\nსტატუსი: ${subStatus}\n\n*ტარიფები:*\n${tariffList}\n\n*გადარიცხვის რეკვიზიტები:*\nIBAN: \`${PAYMENT_DETAILS}\`\n\n⚠️ აუცილებლად მიუთითეთ კოდი:\n*${code}*\n\nგადახდის შემდეგ გამოგზავნეთ ქვითრის სკრინშოტი — ოპერატორი გააქტიურებს გამოწერას.`,
    en: `💳 *Subscription Top-Up*\n\nStatus: ${subStatus}\n\n*Plans:*\n${tariffList}\n\n*Payment details:*\nIBAN: \`${PAYMENT_DETAILS}\`\n\n⚠️ Include transfer code:\n*${code}*\n\nAfter payment, send a screenshot of the receipt here — operator will activate your subscription.`,
  };

  // Сохраняем состояние ожидания чека в reg_state
  const { data: cur } = await supabaseAdmin
    .from('tender_drivers').select('reg_state').eq('id', driver.id).single();
  const regState = ((cur?.reg_state ?? {}) as Record<string, unknown>);
  regState.awaiting_receipt = true;
  await supabaseAdmin.from('tender_drivers')
    .update({ reg_state: regState })
    .eq('id', driver.id);

  await ctx.reply(msgs[lang] ?? msgs.ru, { parse_mode: 'Markdown' });
});

// Инлайн-кнопка "Пополнить" с тем же эффектом что и /topup
async function handleTopup(ctx: Context) {
  await ctx.answerCallbackQuery();
  // Имитируем текстовую команду — вызываем логику через message
  await bot.api.sendMessage(ctx.from!.id, '/topup');
}

// ─── /profile — статус аккаунта и подписки ───────────────────────────────────

bot.command('profile', async (ctx) => {
  const telegramId = ctx.from!.id;

  const { data: driver } = await supabaseAdmin
    .from('tender_drivers')
    .select('id, name, status, driver_language, subscription_expires_at, rating, completed_orders, total_earned')
    .eq('telegram_id', telegramId)
    .maybeSingle();

  if (!driver || driver.status === 'registering') {
    const errLang = (driver?.driver_language as string) ?? 'ru';
    const noRegMsgs: Record<string, string> = {
      ru: 'Вы ещё не зарегистрированы. Введите /start',
      ka: 'თქვენ ჯერ არ ხართ დარეგისტრირებული. შეიყვანეთ /start',
      en: 'You are not registered yet. Type /start',
    };
    await ctx.reply(noRegMsgs[errLang] ?? noRegMsgs.ru);
    return;
  }

  const lang = (driver.driver_language as string) ?? 'ru';
  const expiresAt = driver.subscription_expires_at as string | null;
  const isActive  = expiresAt && new Date(expiresAt) > new Date();
  const expDate   = isActive ? new Date(expiresAt!).toLocaleDateString(lang === 'ka' ? 'ka-GE' : lang === 'en' ? 'en-GB' : 'ru-RU') : null;

  const msgs: Record<string, string> = {
    ru: isActive
      ? `👤 *Мой профиль*\n\nТип аккаунта: Безлимитный 🚀\nДействует до: ${expDate}\n\n⭐ Рейтинг: ${driver.rating.toFixed(1)}\n✅ Выполнено заказов: ${driver.completed_orders}\n💰 Заработано всего: ${driver.total_earned} ₾`
      : `👤 *Мой профиль*\n\nТип аккаунта: Не активен ❌\nДля получения заказов продлите подписку: /topup\n\n⭐ Рейтинг: ${driver.rating.toFixed(1)}\n✅ Выполнено заказов: ${driver.completed_orders}`,
    ka: isActive
      ? `👤 *ჩემი პროფილი*\n\nანგარიშის ტიპი: ულიმიტო 🚀\nმოქმედებს: ${expDate}-მდე\n\n⭐ რეიტინგი: ${driver.rating.toFixed(1)}\n✅ დასრულებული შეკვეთები: ${driver.completed_orders}\n💰 სულ გამომუშავებული: ${driver.total_earned} ₾`
      : `👤 *ჩემი პროფილი*\n\nანგარიშის ტიპი: არ არის აქტიური ❌\nშეკვეთების მისაღებად განაახლეთ გამოწერა: /topup\n\n⭐ რეიტინგი: ${driver.rating.toFixed(1)}\n✅ დასრულებული შეკვეთები: ${driver.completed_orders}`,
    en: isActive
      ? `👤 *My Profile*\n\nAccount type: Unlimited 🚀\nActive until: ${expDate}\n\n⭐ Rating: ${driver.rating.toFixed(1)}\n✅ Completed orders: ${driver.completed_orders}\n💰 Total earned: ${driver.total_earned} ₾`
      : `👤 *My Profile*\n\nAccount type: Not active ❌\nTo receive orders, renew your subscription: /topup\n\n⭐ Rating: ${driver.rating.toFixed(1)}\n✅ Completed orders: ${driver.completed_orders}`,
  };

  await ctx.reply(msgs[lang] ?? msgs.ru, { parse_mode: 'Markdown' });
});

// ─── Приём фото-чека от водителя ─────────────────────────────────────────────

bot.on('message:photo', async (ctx) => {
  const telegramId = ctx.from!.id;

  const { data: driver } = await supabaseAdmin
    .from('tender_drivers')
    .select('id, name, status, driver_language, reg_state')
    .eq('telegram_id', telegramId)
    .maybeSingle();

  if (!driver) return;
  if (driver.status === 'blocked' || driver.status === 'rejected') return;

  // Реагируем только если водитель в режиме ожидания чека
  const regState = (driver.reg_state ?? {}) as Record<string, unknown>;
  if (!regState.awaiting_receipt) return;

  const lang = (driver.driver_language as string) ?? 'ru';
  const code = `MUSH-${driver.id.slice(0, 5).toUpperCase()}`;

  // Строим инлайн-клавиатуру из TARIFF_PLANS
  const keyboard = new InlineKeyboard();
  for (const plan of TARIFF_PLANS) {
    keyboard.text(
      `✅ ${plan.label} (${plan.price} ₾)`,
      `approve_sub:${driver.id}:${plan.id}`
    ).row();
  }
  keyboard.text('❌ Отклонить', `reject_sub:${driver.id}`);

  // Пересылаем фото в админ-чат
  const photo = ctx.message.photo.at(-1)!; // наибольшее разрешение
  await bot.api.sendPhoto(ADMIN_CHAT_ID, photo.file_id, {
    caption:
      `📋 *Чек на подписку*\n\n` +
      `👤 Водитель: *${driver.name}*\n` +
      `🔑 Код: \`${code}\`\n` +
      `🆔 ID: \`${driver.id}\`\n\n` +
      `Выберите тариф для активации:`,
    parse_mode: 'Markdown',
    reply_markup: keyboard,
  });

  // Снимаем флаг ожидания
  const newState = { ...regState };
  delete newState.awaiting_receipt;
  await supabaseAdmin.from('tender_drivers')
    .update({ reg_state: newState })
    .eq('id', driver.id);

  // Подтверждаем водителю
  const ackMsgs: Record<string, string> = {
    ru: '📨 Чек получен! Оператор проверит его и активирует подписку в ближайшее время.',
    ka: '📨 ქვითარი მიღებულია! ოპერატორი შეამოწმებს და გააქტიურებს გამოწერას მალე.',
    en: '📨 Receipt received! The operator will review it and activate your subscription shortly.',
  };
  await ctx.reply(ackMsgs[lang] ?? ackMsgs.ru);
});

// ─── Одобрение подписки оператором ───────────────────────────────────────────

async function handleApproveSubscription(ctx: Context) {
  const parts = ctx.callbackQuery!.data!.split(':');
  // approve_sub:<driver_id>:<plan_id>
  if (parts.length !== 3) { await ctx.answerCallbackQuery({ text: 'Ошибка формата' }); return; }

  const [, driverId, planId] = parts;
  const plan = TARIFF_PLANS.find(p => p.id === (planId as TariffPlanId));
  if (!plan) { await ctx.answerCallbackQuery({ text: 'Неизвестный тариф' }); return; }

  const { data: driver } = await supabaseAdmin
    .from('tender_drivers')
    .select('id, name, telegram_id, driver_language, subscription_expires_at')
    .eq('id', driverId)
    .maybeSingle();

  if (!driver) {
    await ctx.answerCallbackQuery({ text: '❌ Водитель не найден', show_alert: true });
    return;
  }

  // Атомарный апдейт: если подписка ещё активна — продлеваем сверху,
  // если истекла или NULL — отсчёт с NOW().
  // COALESCE(subscription_expires_at, NOW()) + INTERVAL 'X days'
  // но не меньше чем NOW() + X days (чтобы не урезать при продлении заранее).
  const { error } = await supabaseAdmin.rpc('extend_driver_subscription', {
    p_driver_id: driverId,
    p_days:      plan.days,
  });

  if (error) {
    console.error('[handleApproveSubscription] rpc error:', error.message);
    await ctx.answerCallbackQuery({ text: '❌ Ошибка БД. Попробуйте ещё раз.', show_alert: true });
    return;
  }

  // Читаем финальную дату для уведомления водителю
  const { data: updated } = await supabaseAdmin
    .from('tender_drivers')
    .select('subscription_expires_at')
    .eq('id', driverId)
    .single();

  const expiresAt = updated?.subscription_expires_at as string | null;
  const expiresStr = expiresAt
    ? new Date(expiresAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
    : '—';

  const operatorName = ctx.from!.first_name ?? 'Оператор';

  // Обновляем сообщение в админ-чате
  await ctx.editMessageCaption({
    caption:
      `✅ *Подписка активирована*\n\n` +
      `👤 Водитель: *${driver.name}*\n` +
      `📦 Тариф: *${plan.label}* (${plan.price} ₾)\n` +
      `📅 Действует до: *${expiresStr}*\n` +
      `👮 Оператор: ${operatorName}`,
    parse_mode: 'Markdown',
  }).catch(() => {/* сообщение могло быть удалено */});

  await ctx.answerCallbackQuery({ text: `✅ Подписка для ${driver.name} активирована!` });

  // Уведомляем водителя на его языке
  if (driver.telegram_id) {
    const lang = (driver.driver_language as string) ?? 'ru';
    const driverMsgs: Record<string, string> = {
      ru: `🚀 Ваша подписка успешно продлена до ${expiresStr}! Доступ к заказам открыт. Удачной работы!`,
      ka: `🚀 თქვენი გამოწერა წარმატებით გაგრძელდა ${expiresStr}-მდე! შეკვეთებზე წვდომა გახსნილია. წარმატებებს გისურვებთ!`,
      en: `🚀 Your subscription has been renewed until ${expiresStr}! Access to orders is now open. Good luck!`,
    };
    await bot.api
      .sendMessage(driver.telegram_id as number, driverMsgs[lang] ?? driverMsgs.ru)
      .catch(e => console.error('[subscription notify driver]', e));
  }
}

// ─── Отклонение платежа оператором ───────────────────────────────────────────

async function handleRejectSubscription(ctx: Context) {
  const driverId = ctx.callbackQuery!.data!.split(':')[1];
  if (!driverId) { await ctx.answerCallbackQuery({ text: 'Ошибка формата' }); return; }

  const { data: driver } = await supabaseAdmin
    .from('tender_drivers')
    .select('id, name, telegram_id, driver_language')
    .eq('id', driverId)
    .maybeSingle();

  const operatorName = ctx.from!.first_name ?? 'Оператор';
  const driverName   = driver?.name ?? 'Неизвестный';

  await ctx.editMessageCaption({
    caption:
      `❌ *Платёж отклонён*\n\n` +
      `👤 Водитель: *${driverName}*\n` +
      `👮 Оператор: ${operatorName}`,
    parse_mode: 'Markdown',
  }).catch(() => {});

  await ctx.answerCallbackQuery({ text: `Платёж для ${driverName} отклонён` });

  if (driver?.telegram_id) {
    const lang = (driver.driver_language as string) ?? 'ru';
    const rejectMsgs: Record<string, string> = {
      ru: '❌ Ваш платёж не прошёл проверку оператора. Пожалуйста, свяжитесь с поддержкой или попробуйте снова (/topup).',
      ka: '❌ თქვენი გადახდა ვერ გაიარა ოპერატორის შემოწმება. დაუკავშირდით მხარდაჭერას ან სცადეთ თავიდან (/topup).',
      en: '❌ Your payment was not confirmed by the operator. Please contact support or try again (/topup).',
    };
    await bot.api
      .sendMessage(driver.telegram_id as number, rejectMsgs[lang] ?? rejectMsgs.ru)
      .catch(e => console.error('[reject notify driver]', e));
  }
}

// ─── SQL-функция extend_driver_subscription (создать в Supabase) ──────────────
// CREATE OR REPLACE FUNCTION extend_driver_subscription(p_driver_id uuid, p_days int)
// RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
// BEGIN
//   UPDATE tender_drivers SET
//     subscription_expires_at = GREATEST(COALESCE(subscription_expires_at, NOW()), NOW())
//                               + (p_days || ' days')::interval
//   WHERE id = p_driver_id;
// END; $$;

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
    .not('telegram_id', 'is', null)
    .gt('subscription_expires_at', new Date().toISOString());

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
    .from('tender_drivers')
    .select('telegram_id, driver_language')
    .eq('status', 'active')
    .not('telegram_id', 'is', null)
    .gt('subscription_expires_at', new Date().toISOString());
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
