import { createClient } from '@supabase/supabase-js';

// Публичный клиент — безопасен для браузера, только anon key
export const supabaseBrowser = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);
