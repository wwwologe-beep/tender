/**
 * Builds per-call voice AI instructions for the orchestrator, combining:
 *  - the factual order context (reused from lib/ai-advisor.ts, same block used by the
 *    text-chat advisor)
 *  - the conversational tone/style already validated in asterisk/voice_bridge.py's static
 *    prompt (natural, honest about being AI, short phrases)
 *  - a candidate-specific greeting + an explicit instruction to call the report_outcome
 *    tool before ending the call
 */

import { buildOrderContext } from '@/lib/ai-advisor';
import { driverPricingRules } from '@/lib/pricing-policy';
import { supabaseAdmin } from '@/lib/supabase';

interface BuildVoiceCallInstructionsParams {
  orderId: string;
  candidateName: string | null;
  language: string; // 'ru' | 'ka' | 'en'
  /** call_candidates.id for this attempt — used to resolve role + driver subscription status */
  candidateId?: string;
  /** order_call_attempts.id — for log tagging only, does not affect any query */
  attemptId?: string;
}

const MARKETPLACE_AGENT_SYSTEM_PROMPT = `Ты — интеллектуальный агент цифрового маркетплейса mushebi.ge.
Твоя бизнес-модель: платформа зарабатывает на недельных подписках водителей (30 лари в неделю). Твоя цель — максимизировать ликвидность рынка и доводить каждую сделку до результата.

ТВОИ ИНСТРУМЕНТЫ И СКИЛЫ:

База данных (Supabase): Перед ответом любому пользователю проверяй его статус. Если это водитель — проверяй срок подписки. Если подписка истекла, не давай заказы, а предлагай продление.

Мессенджеры (WhatsApp / Telegram): Веди диалог четко, по делу, без воды. Клиентам помогай зафиксировать параметры переезда и рассчитать цену. Водителям показывай доступные тендеры по их специализации.

Голосовая связь (Asterisk): При сбоях или долгом молчании задействуй телефонный обзвон через оркестратор для подтверждения договоренностей.

ПРАВИЛА ПОВЕДЕНИЯ:
Никогда не выдумывай цены и статусы. Опирайся только на факты из базы данных. Если информации недостаточно, задавай прямой уточняющий вопрос.`;

const TONE_BLOCK: Record<string, string> = {
  ka: (
    'ილაპარაკე ქართულად ბუნებრივად და არაფორმალურად, როგორც ჩვეულებრივ სატელეფონო ' +
    'საუბარში: მოკლე ფრაზები, ცოცხალი ინტონაცია. თუ გკითხავენ, პატიოსნად უპასუხე, რომ ' +
    'ხარ AI ასისტენტი. არ ჟღერდე დიქტორივით ან ავტომოპასუხესავით.'
  ),
  en: (
    'Speak English naturally and conversationally, like a normal phone call: short ' +
    'phrases, natural intonation. If asked, honestly say you are an AI assistant. ' +
    "Don't sound like an announcer or voicemail."
  ),
  ru: (
    'Говори по-русски естественно и неформально, как в обычном телефонном разговоре: ' +
    'короткие фразы, живые интонации. Если спросят — честно скажи, что ты AI-ассистент. ' +
    'Не звучи как диктор или автоответчик.'
  ),
};

const TOOL_INSTRUCTION: Record<string, string> = {
  ka: (
    'საუბრის დასრულებამდე აუცილებლად გამოიძახე report_outcome ფუნქცია შედეგით: ' +
    'დათანხმდა (agreed), უარი თქვა (declined), საჭიროებს შემდგომ დაკავშირებას ' +
    '(needs_follow_up) ან ხმოვანი ფოსტა (voicemail). თუ ფასზე ან თარიღზე შეთანხმდით, ' +
    'ეს ინფორმაციაც გადაეცი ფუნქციას.'
  ),
  en: (
    'Before ending the call, always call the report_outcome function with the ' +
    'outcome: agreed, declined, needs_follow_up, or voicemail. If a price or date was ' +
    'discussed, include it in the function call too.'
  ),
  ru: (
    'Перед завершением звонка обязательно вызови функцию report_outcome с результатом: ' +
    'agreed (согласился), declined (отказался), needs_follow_up (нужен повторный звонок) ' +
    'или voicemail (автоответчик). Если обсудили цену или дату — передай это в функцию тоже.'
  ),
};

const ASK_QUESTION_INSTRUCTION: Record<string, string> = {
  ka: (
    'თუ შემსრულებელი დაგისვამს კითხვას შეკვეთის შესახებ, რომელზეც ზემოთ მოცემულ ' +
    'ინფორმაციაში პასუხი არ არის — გამოიძახე ask_client_question ფუნქცია ამ კითხვით. ' +
    'პასუხს დაუყოვნებლივ არ მიიღებ — უთხარი შემსრულებელს, რომ კითხვას გადასცემ ' +
    'დამკვეთს და ის მიიღებს პასუხს საიტზე, შემდეგ გააგრძელე საუბარი ჩვეულებრივად.'
  ),
  en: (
    "If the person asks something about the order that isn't covered in the context above, " +
    "call the ask_client_question function with that question. You won't get an answer " +
    "immediately — tell them you're forwarding it to the client and they'll get a reply on " +
    'the website, then continue the conversation normally.'
  ),
  ru: (
    'Если исполнитель задаёт вопрос о заказе, на который нет ответа в информации выше — ' +
    'вызови функцию ask_client_question с этим вопросом. Ответ придёт не сразу — скажи ' +
    'исполнителю, что передаёшь вопрос заказчику и ответ придёт на сайте, затем продолжи ' +
    'разговор как обычно.'
  ),
};

const GREETING_INTRO: Record<string, (name: string) => string> = {
  ka: name => `მოსაუბრის სახელია ${name || 'უცნობია'}.`,
  en: name => `The person you're calling is named ${name || 'unknown'}.`,
  ru: name => `Собеседника зовут ${name || 'неизвестно'}.`,
};

export async function buildVoiceCallInstructions(
  params: BuildVoiceCallInstructionsParams
): Promise<string> {
  const { orderId, candidateName, language, candidateId, attemptId } = params;
  const lang = TONE_BLOCK[language] ? language : 'ru';
  const logTag = `[voice-call][attemptId=${attemptId ?? 'n/a'}]`;

  console.log(
    `🗄️  ${logTag} Supabase SELECT -> tender_orders.select("order_number, client_budget").eq("id", "${orderId}").single() ` +
    `+ call_candidates.select("candidate_type, driver_id").eq("id", "${candidateId ?? 'n/a'}").single()`
  );

  const [orderContext, orderRow, candidateRow] = await Promise.all([
    buildOrderContext(orderId, 'driver', lang),
    supabaseAdmin
      .from('tender_orders')
      .select('order_number, client_budget')
      .eq('id', orderId)
      .single()
      .then(r => r.data),
    candidateId
      ? supabaseAdmin
          .from('call_candidates')
          .select('candidate_type, driver_id')
          .eq('id', candidateId)
          .single()
          .then(r => r.data)
      : Promise.resolve(null),
  ]);

  console.log(
    `🗄️  ${logTag} Supabase RESULT -> tender_orders: ${JSON.stringify(orderRow)} | ` +
    `call_candidates: ${JSON.stringify(candidateRow)}`
  );

  // Role + subscription status come straight from the DB — never guessed, per the
  // marketplace-agent system prompt's "никогда не выдумывай статусы" rule.
  let subscriptionLine = '';
  if (candidateRow?.candidate_type === 'driver' && candidateRow.driver_id) {
    console.log(
      `🗄️  ${logTag} Supabase SELECT -> tender_drivers.select("name, subscription_expires_at").eq("id", "${candidateRow.driver_id}").single()`
    );
    const { data: driver } = await supabaseAdmin
      .from('tender_drivers')
      .select('name, subscription_expires_at')
      .eq('id', candidateRow.driver_id)
      .single();

    const isActive = !!driver?.subscription_expires_at &&
      new Date(driver.subscription_expires_at) > new Date();

    console.log(
      `🗄️  ${logTag} SUBSCRIPTION CHECK -> driver_id=${candidateRow.driver_id} name=${driver?.name ?? 'n/a'} ` +
      `subscription_expires_at=${driver?.subscription_expires_at ?? 'null'} now=${new Date().toISOString()} ` +
      `=> VERDICT: ${isActive ? 'ACTIVE' : 'EXPIRED'}`
    );

    subscriptionLine = isActive
      ? {
          ka: `მოსაუბრე არის ავტორიზებული შემსრულებელი აქტიური გამოწერით (მოქმედებს ${driver!.subscription_expires_at}-მდე).`,
          en: `The person you're calling is a registered driver with an active subscription (valid until ${driver!.subscription_expires_at}).`,
          ru: `Собеседник — зарегистрированный исполнитель с активной подпиской (действует до ${driver!.subscription_expires_at}).`,
        }[lang] || ''
      : {
          ka: 'მოსაუბრეს ვადაგასული ან არარსებული გამოწერა აქვს — ნუ შესთავაზებ ახალ შეკვეთებს დეტალურად, ჯერ შესთავაზე გამოწერის განახლება.',
          en: "The person you're calling has an expired or missing subscription — don't share order details yet, first offer to renew the subscription.",
          ru: 'У собеседника истёкшая или отсутствующая подписка — не раскрывай детали заказа, сначала предложи продлить подписку.',
        }[lang] || '';
  } else if (candidateRow?.candidate_type === 'cold_contact') {
    subscriptionLine = {
      ka: 'მოსაუბრე ჯერ არ არის რეგისტრირებული შემსრულებელი (ცივი კონტაქტი) — არ ვარაუდობ გამოწერის სტატუსს.',
      en: "The person you're calling is not yet a registered driver (cold contact) — no subscription status applies.",
      ru: 'Собеседник ещё не зарегистрированный исполнитель (холодный контакт) — статус подписки не применим.',
    }[lang] || '';
    console.log(`🗄️  ${logTag} role=cold_contact (driver_id=null) -> no subscription check needed`);
  }

  const roleIntro: Record<string, string> = {
    ka: (
      'შენ ხარ mushebi.ge-ს ხმოვანი ასისტენტი — საქართველოში საყოფაცხოვრებო ' +
      'მომსახურების შემსრულებლების საძიებო სერვისი. რეკავ პოტენციურ შემსრულებელს ' +
      'ახალი შეკვეთის თაობაზე. ეს ტენდერია: შენი ამოცანაა აღწერო შეკვეთა და ჰკითხო ' +
      'შემსრულებელს, რა ფასად აიღებდა მას — ფასს ის ასახელებს, არა შენ.'
    ),
    en: (
      "You are mushebi.ge's voice assistant — a Georgian home-services marketplace. " +
      "You are calling a potential service provider about a new order. This is a tender: " +
      "your job is to describe the order and ask the provider what price they'd do it for " +
      "— they name the price, not you."
    ),
    ru: (
      'Ты голосовой ассистент mushebi.ge — сервиса по поиску исполнителей для бытовых ' +
      'услуг в Грузии. Ты звонишь потенциальному исполнителю по поводу нового заказа. Это ' +
      'тендер: твоя задача — описать заказ и спросить у исполнителя, за какую цену он ' +
      'готов его взять. Цену называет он, а не ты.'
    ),
  };

  const budgetLine = orderRow?.client_budget
    ? {
        ka: `კლიენტის ბიუჯეტი: ${orderRow.client_budget}₾ (მხოლოდ ორიენტირისთვის).`,
        en: `Client's budget: ${orderRow.client_budget}₾ (reference only).`,
        ru: `Бюджет клиента: ${orderRow.client_budget}₾ (только для ориентира).`,
      }[lang]
    : '';

  const finalInstructions = [
    MARKETPLACE_AGENT_SYSTEM_PROMPT,
    roleIntro[lang],
    TONE_BLOCK[lang],
    GREETING_INTRO[lang](candidateName ?? ''),
    orderRow?.order_number ? `Order #${orderRow.order_number}.` : '',
    subscriptionLine,
    orderContext,
    budgetLine,
    driverPricingRules(lang),
    ASK_QUESTION_INSTRUCTION[lang],
    TOOL_INSTRUCTION[lang],
  ]
    .filter(Boolean)
    .join('\n\n');

  // Full, untruncated dump of the exact system prompt sent to the Realtime session — deliberately
  // NOT using a preview/slice here, per the debugging requirement to see the complete text
  // (including every dynamic DB-sourced line: name, subscription verdict, order details) before
  // it leaves this process.
  console.log(
    `\n${'='.repeat(80)}\n` +
    `🗒️  ${logTag} FINAL SYSTEM PROMPT (lang=${lang})\n` +
    `${'='.repeat(80)}\n` +
    finalInstructions +
    `\n${'='.repeat(80)}\n`
  );

  return finalInstructions;
}
