-- Short-lived, single-use codes that sign a second device into an account without sending an email.
-- Used by the link-device Edge Function; mainly for iPhone Home Screen apps, which can't receive email links.
create table if not exists public.device_link_codes (
    code text primary key,
    user_id uuid not null references auth.users (id) on delete cascade,
    token_hash text not null,
    expires_at timestamptz not null
);

-- RLS on with no policies: browsers can't read codes; only the Edge Function (service role) can.
alter table public.device_link_codes enable row level security;
