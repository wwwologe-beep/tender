import OpenAI from 'openai';

let _client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: process.env.OPENROUTER_API_KEY ?? 'placeholder',
      defaultHeaders: {
        'HTTP-Referer': 'https://mushebi.ge',
        'X-Title': 'mushebi.ge marketplace',
      },
    });
  }
  return _client;
}

export interface LocalizedDescription {
  ru: string;
  ka: string;
  en: string;
}

export interface FaqEntry {
  question: LocalizedDescription;
  answer: LocalizedDescription | null;
}

export interface AiOrderAnalysis {
  category: string;
  localized_description: LocalizedDescription;
  ai_summary: string;
  specifications: Record<string, unknown>;
  estimated_duration_hours: number | null;
  price_suggestion: number | null;
}

const CATEGORIES = [
  'general', 'moving', 'cleaning', 'repair',
  'electrician', 'plumber', 'assembly', 'appliances_moving',
  'furniture', 'courier', 'other',
];

// ─── Анализ и перевод заказа одним промптом ──────────────────────────────────

export async function analyzeOrder(rawText: string): Promise<AiOrderAnalysis | null> {
  try {
    const response = await getClient().chat.completions.create({
      model: 'google/gemini-2.5-flash',
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `You are a multilingual order processing assistant for a Georgian services marketplace.
Analyze the customer's service request and return a JSON object with this exact structure:
{
  "category": one of [${CATEGORIES.join(', ')}],
  "localized_description": {
    "ru": "clear Russian description",
    "ka": "clear Georgian description",
    "en": "clear English description"
  },
  "ai_summary": "1-2 sentence summary in Russian for internal use",
  "specifications": { any extracted structured data like floor, weight, area, elevator, etc. },
  "estimated_duration_hours": number or null,
  "price_suggestion": suggested price in GEL (Georgian Lari) as number or null
}
Descriptions should be professional, concise, and natural in each language.
For Georgian (ka), use proper Georgian script.`,
        },
        {
          role: 'user',
          content: rawText,
        },
      ],
    });

    const content = response.choices[0]?.message?.content;
    if (!content) return null;
    return JSON.parse(content) as AiOrderAnalysis;
  } catch (err) {
    console.error('[ai.analyzeOrder]', err);
    return null;
  }
}

// ─── Перевод вопроса мастера клиенту + обратно ───────────────────────────────

export async function translateFaqEntry(
  questionText: string,
  questionLang: 'ru' | 'ka' | 'en',
  existingContext: string,
): Promise<LocalizedDescription | null> {
  try {
    const response = await getClient().chat.completions.create({
      model: 'google/gemini-2.5-flash',
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `You are a translation assistant for a services marketplace.
Translate the question to all three languages and return JSON:
{ "ru": "...", "ka": "...", "en": "..." }
Context about the order: ${existingContext}
Keep questions natural and concise. Georgian must use Georgian script.`,
        },
        {
          role: 'user',
          content: `Question in ${questionLang}: "${questionText}"`,
        },
      ],
    });

    const content = response.choices[0]?.message?.content;
    if (!content) return null;
    return JSON.parse(content) as LocalizedDescription;
  } catch (err) {
    console.error('[ai.translateFaqEntry]', err);
    return null;
  }
}

export async function translateFaqAnswer(
  answerText: string,
  answerLang: 'ru' | 'ka' | 'en',
): Promise<LocalizedDescription | null> {
  try {
    const response = await getClient().chat.completions.create({
      model: 'google/gemini-2.5-flash',
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `Translate this answer to all three languages. Return JSON: { "ru": "...", "ka": "...", "en": "..." }
Georgian must use Georgian script. Keep it natural.`,
        },
        { role: 'user', content: `Answer in ${answerLang}: "${answerText}"` },
      ],
    });

    const content = response.choices[0]?.message?.content;
    if (!content) return null;
    return JSON.parse(content) as LocalizedDescription;
  } catch (err) {
    console.error('[ai.translateFaqAnswer]', err);
    return null;
  }
}

// ─── Перевод сообщения чата на целевой язык ──────────────────────────────────

export async function translateChatMessage(
  text: string,
  fromLang: 'ru' | 'ka' | 'en',
  toLang: 'ru' | 'ka' | 'en',
): Promise<string> {
  if (fromLang === toLang) return text;
  try {
    const response = await getClient().chat.completions.create({
      model: 'google/gemini-2.5-flash',
      temperature: 0.1,
      messages: [
        {
          role: 'system',
          content: `You are a translator for a home services marketplace chat. Translate the message naturally and concisely. Return only the translated text, nothing else. Target language: ${toLang === 'ka' ? 'Georgian (Georgian script)' : toLang === 'ru' ? 'Russian' : 'English'}.`,
        },
        { role: 'user', content: text },
      ],
    });
    return response.choices[0]?.message?.content?.trim() ?? text;
  } catch {
    return text; // fallback — оригинал если перевод не удался
  }
}

// ─── Генерация WhatsApp-шаблона ───────────────────────────────────────────────

export async function generateWhatsAppGreeting(
  orderDescription: string,
  orderId: string,
  targetLang: 'ru' | 'ka' | 'en',
): Promise<string> {
  try {
    const response = await getClient().chat.completions.create({
      model: 'google/gemini-2.5-flash',
      temperature: 0.3,
      messages: [
        {
          role: 'system',
          content: `Generate a short, friendly WhatsApp greeting message in ${targetLang} language for a service executor contacting a client.
The message should say they were selected for the job and briefly mention the task.
Return only the message text, nothing else. Max 2 sentences.`,
        },
        {
          role: 'user',
          content: `Order #${orderId.slice(0, 8).toUpperCase()}: ${orderDescription}`,
        },
      ],
    });

    return response.choices[0]?.message?.content?.trim() ?? '';
  } catch {
    return '';
  }
}
