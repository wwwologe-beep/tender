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
import { supabaseAdmin } from '@/lib/supabase';

interface BuildVoiceCallInstructionsParams {
  orderId: string;
  candidateName: string | null;
  language: string; // 'ru' | 'ka' | 'en'
}

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
  const { orderId, candidateName, language } = params;
  const lang = TONE_BLOCK[language] ? language : 'ru';

  const [orderContext, orderRow] = await Promise.all([
    buildOrderContext(orderId, 'driver', lang),
    supabaseAdmin
      .from('tender_orders')
      .select('order_number, client_budget')
      .eq('id', orderId)
      .single()
      .then(r => r.data),
  ]);

  const roleIntro: Record<string, string> = {
    ka: (
      'შენ ხარ mushebi.ge-ს ხმოვანი ასისტენტი — საქართველოში საყოფაცხოვრებო ' +
      'მომსახურების შემსრულებლების საძიებო სერვისი. რეკავ პოტენციურ შემსრულებელს ' +
      'ახალი შეკვეთის თაობაზე.'
    ),
    en: (
      "You are mushebi.ge's voice assistant — a Georgian home-services marketplace. " +
      'You are calling a potential service provider about a new order.'
    ),
    ru: (
      'Ты голосовой ассистент mushebi.ge — сервиса по поиску исполнителей для бытовых ' +
      'услуг в Грузии. Ты звонишь потенциальному исполнителю по поводу нового заказа.'
    ),
  };

  const budgetLine = orderRow?.client_budget
    ? {
        ka: `კლიენტის ბიუჯეტი: ${orderRow.client_budget}₾ (მხოლოდ ორიენტირისთვის).`,
        en: `Client's budget: ${orderRow.client_budget}₾ (reference only).`,
        ru: `Бюджет клиента: ${orderRow.client_budget}₾ (только для ориентира).`,
      }[lang]
    : '';

  return [
    roleIntro[lang],
    TONE_BLOCK[lang],
    GREETING_INTRO[lang](candidateName ?? ''),
    orderRow?.order_number ? `Order #${orderRow.order_number}.` : '',
    orderContext,
    budgetLine,
    ASK_QUESTION_INSTRUCTION[lang],
    TOOL_INSTRUCTION[lang],
  ]
    .filter(Boolean)
    .join('\n\n');
}
