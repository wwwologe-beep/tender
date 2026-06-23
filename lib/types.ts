// Центральные типы БД-сущностей mushebi.ge
// Обновляй при каждой миграции, затем запускай tsc --noEmit

export interface Driver {
  id:                      string;
  telegram_id:             number | null;
  name:                    string;
  phone:                   string;
  status:                  'active' | 'blocked' | 'registering';
  driver_language:         'ru' | 'ka' | 'en';
  specialization:          string | null;
  rating:                  number;
  rating_sum:              number;
  rating_count:            number;
  completed_orders:        number;
  total_earned:            number;
  // Монетизация: недельная подписка (миграция 20260622)
  subscription_expires_at: string | null;
  reg_state:               Record<string, unknown> | null;
  active_order_id:         string | null;
  last_completed_at:       string | null;
  created_at:              string;
}

export interface TenderOrder {
  id:                string;
  token:             string;
  status:            'bidding' | 'selected' | 'completed' | 'cancelled';
  cargo_description: string | null;
  address_from:      string | null;
  address_to:        string | null;
  client_phone:      string;
  client_budget:     number | null;
  category:          string | null;
  live_brief_ai:     string | null;
  original_text:     string | null;
  faq_summary:       string | null;
  created_at:        string;
  completed_at:      string | null;
  client_rating:     number | null;
  client_review:     string | null;
  rated_at:          string | null;
}

export interface TenderBid {
  id:         string;
  order_id:   string;
  driver_id:  string;
  amount:     number;
  status:     'pending' | 'winner' | 'lost' | 'withdrawn';
  comment:    string | null;
  bot_state:  string | null;
  created_at: string;
}

export const TARIFF_PLANS = [
  { id: '1_week',  label: '1 неделя', days: 7,  price: 30  },
  { id: '2_weeks', label: '2 недели', days: 14, price: 55  },
  { id: '1_month', label: '1 месяц',  days: 30, price: 100 },
] as const;

export type TariffPlanId = typeof TARIFF_PLANS[number]['id'];

export interface NotificationQueueItem {
  id:            string;
  order_id:      string;
  driver_id:     string;
  telegram_id:   number;
  status:        'pending' | 'sent' | 'failed';
  error_message: string | null;
  created_at:    string;
  sent_at:       string | null;
}
