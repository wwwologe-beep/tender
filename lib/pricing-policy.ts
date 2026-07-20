/**
 * Shared pricing/risk rules for interfaces that discuss price on the platform's behalf.
 *
 * driverSystemPrompt() in lib/ai-advisor.ts has its own, more detailed version of these rules
 * (tuned for a back-and-forth chat: "ask 2 clarifying questions", a ±30% bid-history range,
 * rating-based pricing) — that one is intentionally left untouched here, since it's already
 * validated and specific to the chat advisor's turn-by-turn interaction style.
 *
 * This module exists because voice calls (lib/orchestrator/prompts.ts, confirmation-call.ts)
 * had NO pricing logic at all before 2026-07-20 — a cold-contact candidate negotiating a price
 * over the phone got zero protection a Telegram-registered driver gets for free through the
 * text advisor. This is the minimal, single-turn-appropriate subset of those same rules,
 * written for a voice AI that has one shot to get it right, not a multi-turn conversation.
 */

export function driverPricingRules(lang: string): string {
  const rules: Record<string, string> = {
    ru: (
      'ВАЖНЫЕ ПРАВИЛА ЦЕНООБРАЗОВАНИЯ:\n' +
      '1. Если описание заказа короткое или размытое (мало деталей) — сначала уточни детали. Не называй цену пока не ясны детали.\n' +
      '2. Если в заказе есть слова: "офис", "компания", "несколько комнат", "рабочие места", "3+ грузчика" — это B2B заказ. Цена B2B в 2-3 раза выше стандартной.\n' +
      '3. Если клиент/заказчик давит на цену ниже рыночного диапазона — не соглашайся сходу. Объясни: "Это ниже рыночной цены." и почему.\n' +
      '4. Если возникла жалоба или конфликт — предложи конкретное решение (фотофиксация, частичная компенсация, извинение), не игнорируй.\n' +
      '5. Никогда не советуй и не соглашайся обходить платформу или работать напрямую в обход неё.\n' +
      '6. Оценивай заказ исходя из рыночного диапазона ставок и истории — не из имени или языка собеседника.'
    ),
    ka: (
      'ᲤᲐᲡᲘᲡ ᲒᲐᲜᲡᲐᲖᲦᲕᲠᲘᲡ ᲬᲔᲡᲔᲑᲘ:\n' +
      '1. თუ შეკვეთის აღწერა მოკლეა ან გაურკვეველია — ჯერ დააზუსტე დეტალები. ფასი — მხოლოდ დეტალების გარკვევის შემდეგ.\n' +
      '2. თუ შეკვეთაში არის: "ოფისი", "კომპანია", "3+ მუშა", "სამუშაო ადგილები" — ეს B2B შეკვეთაა. ფასი 2-3-ჯერ მეტი სტანდარტულზე.\n' +
      '3. თუ მოითხოვენ ფასს ბაზრის ქვემოთ — არ დაუთმო მაშინვე. აუხსენი, რომ ეს ბაზრის ფასზე დაბალია.\n' +
      '4. კონფლიქტის ან საჩივრის შემთხვევაში — შესთავაზე კონკრეტული გადაწყვეტა, ნუ დააიგნორებ.\n' +
      '5. არასოდეს ურჩიო პლატფორმის გვერდის ავლა.\n' +
      '6. შეაფასე შეკვეთა ბაზრის დიაპაზონისა და ისტორიის მიხედვით — არა სახელის ან ენის მიხედვით.'
    ),
    en: (
      'PRICING RULES:\n' +
      '1. If the order description is short or vague — clarify details first. Don\'t name a price until details are clear.\n' +
      '2. If the order mentions "office", "company", "multiple rooms", "workplaces", "3+ workers" — it\'s a B2B order. B2B price is 2-3x higher than standard.\n' +
      '3. If pressured toward a price below the market range — don\'t give in immediately. Explain that it\'s below market rate.\n' +
      '4. If a complaint or conflict comes up — offer a concrete resolution, don\'t ignore it.\n' +
      '5. Never advise or agree to bypassing the platform.\n' +
      '6. Evaluate the order based on the market bid range and history — not name or language.'
    ),
  };
  return rules[lang] ?? rules.ru;
}
