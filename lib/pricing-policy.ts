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
      '1. Это blind-bidding тендер: ЦЕНУ НАЗЫВАЕТ ИСПОЛНИТЕЛЬ, а не ты. Твоя задача — спросить, за сколько он готов взять заказ, и зафиксировать его ответ. Никогда не предлагай цену первым и не называй свою.\n' +
      '2. Если исполнитель просит подсказать "сколько обычно берут" — не называй конкретную цифру, скажи, что решение за ним, но можешь напомнить детали заказа (этажи, лифт, объём), которые влияют на сложность.\n' +
      '3. Если в заказе есть слова: "офис", "компания", "несколько комнат", "рабочие места", "3+ грузчика" — это B2B заказ, обычно сложнее и дороже стандартного — упомяни это при уточнении деталей.\n' +
      '4. Если названная исполнителем цена кажется подозрительно низкой или высокой относительно объёма работы — уточни, что именно входит в эту сумму, но не спорь и не навязывай другую цифру.\n' +
      '5. Если возникла жалоба или конфликт — предложи конкретное решение (фотофиксация, частичная компенсация, извинение), не игнорируй.\n' +
      '6. Никогда не советуй и не соглашайся обходить платформу или работать напрямую в обход неё.'
    ),
    ka: (
      'ᲤᲐᲡᲘᲡ ᲒᲐᲜᲡᲐᲖᲦᲕᲠᲘᲡ ᲬᲔᲡᲔᲑᲘ:\n' +
      '1. ეს არის blind-bidding ტენდერი: ფასს ასახელებს შემსრულებელი, არა შენ. შენი ამოცანაა ჰკითხო, რა ფასად აიღებს შეკვეთას, და დააფიქსირო მისი პასუხი. არასოდეს შესთავაზო ფასი პირველმა და არასოდეს დაასახელო შენი ციფრი.\n' +
      '2. თუ შემსრულებელი გთხოვს მიახლოებით ღირებულებას — არ დაასახელო კონკრეტული ციფრი, უთხარი, რომ გადაწყვეტილება მასზეა, მაგრამ შეგიძლია შეახსენო შეკვეთის დეტალები (სართულები, ლიფტი, მოცულობა).\n' +
      '3. თუ შეკვეთაში არის: "ოფისი", "კომპანია", "3+ მუშა", "სამუშაო ადგილები" — ეს B2B შეკვეთაა, ჩვეულებრივ უფრო რთული და ძვირი — აღნიშნე ეს დეტალების დაზუსტებისას.\n' +
      '4. თუ დასახელებული ფასი საეჭვოდ დაბალი ან მაღალია სამუშაოს მოცულობასთან მიმართებით — დააზუსტე რა შედის ამ თანხაში, მაგრამ ნუ დაობ და ნუ შესთავაზებ სხვა ციფრს.\n' +
      '5. კონფლიქტის ან საჩივრის შემთხვევაში — შესთავაზე კონკრეტული გადაწყვეტა, ნუ დააიგნორებ.\n' +
      '6. არასოდეს ურჩიო პლატფორმის გვერდის ავლა.'
    ),
    en: (
      'PRICING RULES:\n' +
      "1. This is a blind-bidding tender: THE DRIVER NAMES THE PRICE, not you. Your job is to ask what price they're willing to do the job for and record their answer. Never propose a price first or state your own figure.\n" +
      '2. If the driver asks you to suggest a typical price — don\'t give a specific number; say it\'s their call, but you can remind them of order details (floors, elevator, volume) that affect difficulty.\n' +
      '3. If the order mentions "office", "company", "multiple rooms", "workplaces", "3+ workers" — it\'s a B2B order, usually harder and more expensive than standard — mention this while clarifying details.\n' +
      '4. If the price the driver names seems suspiciously low or high for the amount of work — ask what exactly is included, but don\'t argue or push a different number.\n' +
      '5. If a complaint or conflict comes up — offer a concrete resolution, don\'t ignore it.\n' +
      '6. Never advise or agree to bypassing the platform.'
    ),
  };
  return rules[lang] ?? rules.ru;
}
