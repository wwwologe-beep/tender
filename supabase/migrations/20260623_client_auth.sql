-- OTP codes for passwordless client login
create table if not exists client_otp_codes (
  phone       text primary key,
  code        text        not null,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);

-- Cleanup stale codes automatically
create index if not exists idx_otp_expires on client_otp_codes (expires_at);

-- Client profiles (created on first successful OTP)
create table if not exists tender_clients (
  id             uuid        primary key default gen_random_uuid(),
  phone          text        unique not null,
  session_token  text,
  last_login     timestamptz,
  created_at     timestamptz not null default now()
);

-- Row-level security: allow anon insert/update for OTP flow
alter table client_otp_codes enable row level security;
create policy "anon can upsert otp" on client_otp_codes
  for all using (true) with check (true);

alter table tender_clients enable row level security;
create policy "anon can upsert clients" on tender_clients
  for all using (true) with check (true);
