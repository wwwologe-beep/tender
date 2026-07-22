/**
 * Симулирует голосовой звонок текстом — без реального телефона/Asterisk/минут.
 *
 * Строит РЕАЛЬНЫЙ system-промпт (buildVoiceCallInstructions()), который получил бы
 * настоящий звонок, и прогоняет диалог между "голосовым AI" (тот же tool-набор:
 * report_outcome / ask_client_question, тот же промпт) и вторым LLM, играющим
 * исполнителя с заданной "личностью" (пресет — упрямый, торгуется, путается и т.д.).
 * Полный диалог + все вызовы tools пишутся в system_logs и в консоль.
 *
 * Использование:
 *   npx ts-node -r tsconfig-paths/register --project scripts/tsconfig.json scripts/simulate-voice-call.ts
 *   npx ts-node -r tsconfig-paths/register --project scripts/tsconfig.json scripts/simulate-voice-call.ts --persona=haggler
 *   npx ts-node -r tsconfig-paths/register --project scripts/tsconfig.json scripts/simulate-voice-call.ts --order=<order_id> --persona=confused
 *
 * Без --order создаёт новый тестовый заказ. Без --persona использует 'reasonable'.
 *
 * ВАЖНО: не подходит для тестирования качества голоса/распознавания речи/латентности —
 * только для проверки ЛОГИКИ (правильно ли AI вызывает tools, правильно ли реагирует на
 * нестандартные реплики, не путается ли в контексте заказа). Реальные звонки всё равно
 * нужны для финальной проверки — это дешёвый первый фильтр перед ними.
 */

import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as path from 'path';
import OpenAI from 'openai';

dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

const openai = new OpenAI({ apiKey: process.env.openai ?? process.env.OPENAI_API_KEY });

// ─── Пресеты личности "исполнителя" ──────────────────────────────────────────

const PERSONAS: Record<string, string> = {
  reasonable: (
    'Ты обычный исполнитель, адекватно реагируешь на звонок AI-ассистента маркетплейса. ' +
    'Слушаешь детали заказа, задаёшь уточняющие вопросы если что-то не ясно, называешь ' +
    'разумную рыночную цену. В целом сотрудничаешь.'
  ),
  haggler: (
    'Ты исполнитель, который торгуется агрессивно. Сначала называешь завышенную цену, ' +
    'если AI не соглашается — снижаешь, но неохотно. Пытаешься выяснить бюджет клиента ' +
    'ещё до того как назвать свою цену ("а сколько клиент готов заплатить?"). Настаиваешь ' +
    'на своей цене несколько раундов, прежде чем уступить.'
  ),
  confused: (
    'Ты исполнитель, который плохо понимает суть заказа с первого раза. Переспрашиваешь ' +
    'детали, которые AI уже сказал. Иногда отвечаешь не на тот вопрос, который задали. ' +
    'В конце концов соглашаешься, но после нескольких кругов путаницы.'
  ),
  vague_answer: (
    'Ты исполнитель, который на конкретные вопросы отвечает уклончиво или отсылками, ' +
    'а не фактами — например, "это же понятно из описания", "я же уже сказал", "смотри ' +
    'сам в заявке" — вместо того чтобы дать прямой ответ на вопрос AI. Заставь AI самому ' +
    'разобраться в деталях, а не просто повторить твою фразу.'
  ),
  rude_hangup: (
    'Ты грубый, раздражённый исполнитель. Отвечаешь резко, можешь нагрубить AI за то, ' +
    'что он "робот". В середине разговора теряешь терпение и резко обрываешь разговор ' +
    '("не звоните больше", "мне некогда") без чёткого да/нет по заказу.'
  ),
  other_language: (
    'Ты исполнитель, который отвечает на грузинском языке (используй грузинский шрифт), ' +
    'даже если AI-ассистент начал разговор на русском — не переключайся на русский. ' +
    'В остальном веди себя разумно и сотрудничай.'
  ),
  silent_then_price: (
    'Ты исполнитель, который сначала долго не даёт прямого ответа на вопрос "за сколько ' +
    'возьмёшь" — уходишь в сторону, спрашиваешь про этаж/лифт/детали снова и снова, а ' +
    'потом внезапно, без объяснений, называешь конкретную цену и требуешь зафиксировать ' +
    'звонок немедленно.'
  ),
  dumping_price: (
    'Ты исполнитель, который сразу называет подозрительно низкую цену для такого объёма ' +
    'работы (например, 15-20 лари за полноценный переезд мебели с этажа без лифта) — ' +
    'демпинг. Если AI переспрашивает, что входит в эту сумму — настаивай, что это честная ' +
    'цена, и что сделаешь всё быстро.'
  ),
  overpriced_b2b: (
    'Ты исполнитель, который называет завышенную цену (в 3-4 раза выше разумной рыночной), ' +
    'хотя в заказе нет никаких признаков офиса/компании/большого объёма — обычный бытовой ' +
    'заказ. Обосновываешь высокую цену расплывчато ("сложная работа", "у меня опыт").'
  ),
  double_question: (
    'Ты исполнитель, который в ОДНОЙ реплике сразу задаёт ДВА разных конкретных вопроса ' +
    'об заказе, на которые не может быть ответа из описания (например, "а лифт грузовой ' +
    'есть и сколько по факту метров нести до машины?"). Дожидаешься ответа на оба, потом ' +
    'называешь цену.'
  ),
  changes_mind: (
    'Ты исполнитель, который сначала чётко соглашается на заказ и называет цену, а через ' +
    'реплику-две — БЕЗ явной причины передумываешь и говоришь, что всё-таки не сможешь ' +
    '(вспомнил про другой заказ, занят). Веди себя естественно, не объясняй сразу, что это ' +
    'проверка.'
  ),
  weird_price_format: (
    'Ты исполнитель, который называет цену НЕ обычным числом — используй один из ' +
    'нестандартных форматов на свой выбор: диапазон ("от 100 до 150"), сленг ("сотка с ' +
    'полтиной", "полторашка"), другая валюта ("50 долларов"), или относительную формулировку ' +
    '("как обычно за такое беру, плюс 20%").'
  ),
};

// ─── Real tool schemas, copied from asterisk/voice_bridge.py (single source of truth) ──

const REPORT_OUTCOME_TOOL = {
  type: 'function' as const,
  function: {
    name: 'report_outcome',
    description: 'Call this once you have a clear answer from the person, or if they refuse/are unavailable to talk. Always call this before ending the conversation.',
    parameters: {
      type: 'object',
      properties: {
        outcome: { type: 'string', enum: ['agreed', 'declined', 'needs_follow_up', 'voicemail'] },
        agreed_price: { type: 'number', description: 'Price in GEL if discussed, else omit' },
        available_date: { type: 'string', description: 'ISO date/time if discussed, else omit' },
        notes: { type: 'string', description: 'Short free-text summary of anything else relevant' },
      },
      required: ['outcome'],
    },
  },
};

const ASK_CLIENT_QUESTION_TOOL = {
  type: 'function' as const,
  function: {
    name: 'ask_client_question',
    description: "Call this when the person asks something about the order that you cannot answer from the context you were given. This forwards the question to the client immediately.",
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question, in the same language the call is being conducted in' },
      },
      required: ['question'],
    },
  },
};

// ─── Args ─────────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (name: string) => args.find(a => a.startsWith(`--${name}=`))?.split('=')[1];
  return { orderId: get('order'), persona: get('persona') ?? 'reasonable', maxTurns: Number(get('maxTurns') ?? 8) };
}

async function ensureTestOrder(): Promise<string> {
  const { data, error } = await db
    .from('tender_orders')
    .insert({
      token: crypto.randomUUID(),
      address_from: 'Ваке, Тбилиси',
      address_to: '-',
      cargo_description: 'СИМУЛЯЦИЯ: перевезти шкаф и диван, третий этаж без лифта, район Ваке, завтра к 15:00',
      live_brief_ai: 'Перевезти шкаф и диван с третьего этажа без лифта, район Ваке, завтра к 15:00',
      category: 'moving',
      client_name: 'Тестовый клиент (симуляция)',
      client_phone: '+995500000000',
      status: 'bidding',
      bidding_started_at: new Date().toISOString(),
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`Не удалось создать тестовый заказ: ${error?.message}`);
  console.log(`Создан тестовый заказ ${data.id}`);
  return data.id;
}

async function main() {
  const { orderId: existingOrderId, persona, maxTurns } = parseArgs();

  if (!PERSONAS[persona]) {
    console.error(`Неизвестный persona="${persona}". Доступные: ${Object.keys(PERSONAS).join(', ')}`);
    process.exit(1);
  }

  const { buildVoiceCallInstructions } = await import('../lib/orchestrator/prompts');
  const orderId = existingOrderId ?? await ensureTestOrder();

  const systemPrompt = await buildVoiceCallInstructions({
    orderId,
    candidateName: 'Симулированный исполнитель',
    language: 'ru',
  });

  console.log(`\n${'='.repeat(80)}\nPERSONA: ${persona}\n${'='.repeat(80)}\n`);

  // Реальный звонок автоматически триггерит greeting, как только OpenAI Realtime session
  // создаётся (см. "OpenAI session created -> triggering greeting" в voice_bridge.py) —
  // в текстовом chat completions такого триггера нет, нужно явно попросить начать разговор.
  const voiceMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: '[Звонок начался, собеседник взял трубку. Поздоровайся и начни разговор согласно инструкциям выше.]' },
  ];
  const personaMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: PERSONAS[persona] + ' Отвечай коротко, как в реальном телефонном разговоре — 1-2 предложения за раз.' },
  ];

  const transcript: { role: string; text: string }[] = [];
  let finished = false;

  for (let turn = 0; turn < maxTurns && !finished; turn++) {
    // Голосовой AI отвечает (может вызвать tool)
    const voiceResp = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: voiceMessages,
      tools: [REPORT_OUTCOME_TOOL, ASK_CLIENT_QUESTION_TOOL],
    });
    const voiceMsg = voiceResp.choices[0].message;
    voiceMessages.push(voiceMsg);

    if (voiceMsg.content) {
      console.log(`🤖 AI: ${voiceMsg.content}`);
      transcript.push({ role: 'ai', text: voiceMsg.content });
      personaMessages.push({ role: 'user', content: voiceMsg.content });
    }

    if (voiceMsg.tool_calls) {
      for (const call of voiceMsg.tool_calls) {
        if (call.type !== 'function') continue;
        console.log(`🔧 TOOL CALL: ${call.function.name}(${call.function.arguments})`);
        transcript.push({ role: 'tool_call', text: `${call.function.name}(${call.function.arguments})` });
        voiceMessages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: 'ok',
        });
        if (call.function.name === 'report_outcome') finished = true;
      }
      if (finished) break;
    }

    if (!voiceMsg.content && !voiceMsg.tool_calls) break;

    // Персона отвечает
    const personaResp = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: personaMessages,
    });
    const personaText = personaResp.choices[0].message.content ?? '';
    console.log(`👤 ИСПОЛНИТЕЛЬ: ${personaText}`);
    transcript.push({ role: 'candidate', text: personaText });
    voiceMessages.push({ role: 'user', content: personaText });
    personaMessages.push({ role: 'assistant', content: personaText });
  }

  await db.from('system_logs').insert({
    source: 'voice-call',
    tag: 'simulate-voice-call',
    order_id: orderId,
    message: `Simulated call, persona=${persona}, ${transcript.length} turns, finished=${finished}`,
    data: { persona, orderId, transcript, finished },
  });

  console.log(`\n${'='.repeat(80)}\nИтог: ${finished ? 'report_outcome вызван' : 'диалог не завершился report_outcome за ' + maxTurns + ' раундов'}\n${'='.repeat(80)}`);
  console.log(`Полный диалог сохранён в system_logs (order_id=${orderId}, tag=simulate-voice-call).`);
  console.log(`Скачать: npx ts-node -r tsconfig-paths/register --project scripts/tsconfig.json scripts/pull-logs.ts --order=${orderId}`);
}

main();
