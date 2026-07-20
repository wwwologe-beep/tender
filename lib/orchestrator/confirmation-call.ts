/**
 * Winner-confirmation call — fired from app/api/tender/accept-bid/route.ts right after a
 * client picks a winner. This is a one-way notification (no report_outcome, no ask_client_
 * question), separate from the candidate call-sequence machinery in tick.ts/sequence.ts:
 * there's no order_call_attempts row for it (it isn't a "should we call the next candidate"
 * decision), so it uses originateCall's `instructions` passthrough with a synthetic
 * "confirm:<bidId>" attempt id purely for logging/dedup on the bridge side.
 *
 * Exists because Telegram-registered drivers already get the win notification via the bot
 * (see accept-bid/route.ts's bot.api.sendMessage calls) — but a winner who only exists as a
 * cold-contact-derived tender_drivers row (telegram_id: NULL, see handleAgreedOutcome in
 * app/api/orchestrator/call-result/route.ts) has no other channel to learn they won at all.
 */

import { supabaseAdmin } from '@/lib/supabase';
import { driverPricingRules } from '@/lib/pricing-policy';
import { originateCall } from './bridge-client';

const TRUNK_CALLER_ID = process.env.ORCHESTRATOR_CALLER_ID ?? '';

interface ConfirmWinnerParams {
  orderId: string;
  bidId: string;
  driverId: string;
  amount: number;
}

const CONFIRM_INTRO: Record<string, string> = {
  ka: (
    'შენ ხარ mushebi.ge-ს ხმოვანი ასისტენტი. რეკავ შემსრულებელს, რომელიც კლიენტმა ' +
    'აირჩია გამარჯვებულად კონკრეტულ შეკვეთაზე. მოკლედ დაუდასტურე: შეკვეთა მასზეა, ' +
    'შეთანხმებული თანხაა {amount}₾. უთხარი, რომ კლიენტის საკონტაქტო ინფორმაცია ' +
    'უკვე ხელმისაწვდომია საიტზე/ბოტში. საუბარი ხარკოცე და მოკლე იყოს — ეს მხოლოდ ' +
    'დადასტურებაა, არა მოლაპარაკება.\n\n' +
    'თუ შემსრულებელი ამბობს, რომ ვერ შეძლებს (გადაიფიქრა, დაკავებულია, ვერ ' +
    'გაართმევს თავს) — პატიოსნად და თანაგრძნობით მიიღე ეს, ნუ დაარწმუნებ ან ' +
    'დავობთ. ორივე შემთხვევაში, საუბრის ბოლოს აუცილებლად გამოიძახე ' +
    'report_confirmation_result: confirmed თუ დაადასტურა, declined თუ გადაიფიქრა ' +
    'ან ვერ შეძლებს.'
  ),
  en: (
    "You are mushebi.ge's voice assistant. You are calling a service provider who the " +
    'client just selected as the winner for a specific order. Briefly confirm: the order ' +
    'is theirs, the agreed price is {amount}₾. Tell them the client contact details are ' +
    'already available on the website/bot. Keep it short — this is a confirmation, not a ' +
    'negotiation.\n\n' +
    "If they say they can't do it after all (changed their mind, got busy, can't manage " +
    "it) — accept that honestly and with understanding, don't argue or try to convince " +
    'them. Either way, always call report_confirmation_result at the end: confirmed if ' +
    'they confirmed, declined if they backed out.'
  ),
  ru: (
    'Ты голосовой ассистент mushebi.ge. Звонишь исполнителю, которого клиент только что ' +
    'выбрал победителем по конкретному заказу. Коротко подтверди: заказ за ним, ' +
    'согласованная цена — {amount}₾. Скажи, что контакты клиента уже доступны на сайте/в ' +
    'боте. Разговор короткий — это подтверждение, а не переговоры.\n\n' +
    'Если исполнитель говорит, что не сможет (передумал, занят, не справится) — прими ' +
    'это честно и с пониманием, не уговаривай и не спорь. В любом случае, в конце ' +
    'разговора обязательно вызови report_confirmation_result: confirmed если подтвердил, ' +
    'declined если отказался.'
  ),
};

function buildConfirmationInstructions(amount: number, lang: string): string {
  const template = CONFIRM_INTRO[lang] ?? CONFIRM_INTRO.ru;
  // The price is already agreed by this point — pricing rules matter here mainly for the case
  // where the driver tries to renegotiate down/up or suggests going around the platform on
  // this call, not for setting an initial price (that already happened on the outreach call).
  return template.replace('{amount}', String(amount)) + '\n\n' + driverPricingRules(lang);
}

/**
 * Best-effort — never throws. Called fire-and-forget from accept-bid so a bridge/phone
 * failure never blocks the client-facing bid-acceptance response.
 */
export async function confirmWinnerByCall(params: ConfirmWinnerParams): Promise<void> {
  const { data: driver } = await supabaseAdmin
    .from('tender_drivers')
    .select('phone, driver_language, telegram_id')
    .eq('id', params.driverId)
    .single();

  if (!driver?.phone) return;

  // Telegram-registered drivers already got the win notification via the bot in
  // accept-bid/route.ts — a confirmation call would be redundant. This call exists
  // specifically for winners with no other notification channel.
  if (driver.telegram_id) return;

  const lang = driver.driver_language || 'ru';
  const instructions = buildConfirmationInstructions(params.amount, lang);

  // orderId/bidId are encoded directly in the synthetic attempt id (no order_call_attempts
  // row exists for confirmation calls) so /api/orchestrator/confirmation-result can act on
  // the right order without a DB lookup keyed by a real attempt.
  await originateCall({
    attemptId: `confirm:${params.bidId}:${params.orderId}`,
    phone: driver.phone,
    callerId: TRUNK_CALLER_ID,
    instructions,
  }).catch(err => console.error('[confirmWinnerByCall] originate failed', err));
}
