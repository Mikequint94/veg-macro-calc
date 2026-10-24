-- Daily AI request counts per user, used by the gemini-proxy Edge Function.
create table if not exists public.ai_usage (
    user_id uuid not null references auth.users (id) on delete cascade,
    day date not null default current_date,
    count integer not null default 0,
    primary key (user_id, day)
);

-- RLS on with no policies: browsers can't read or edit counts; only the Edge Function (service role) can.
alter table public.ai_usage enable row level security;

-- Atomically counts one request, refusing it when the user or the whole app is over today's limit.
create or replace function public.claim_ai_request(p_user uuid, p_user_limit integer, p_global_limit integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    used integer;
    total integer;
begin
    select coalesce(sum(count), 0) into total from ai_usage where day = current_date;
    if total >= p_global_limit then
        return jsonb_build_object('status', 'global_limit', 'used', null);
    end if;

    insert into ai_usage (user_id, day, count) values (p_user, current_date, 1)
    on conflict (user_id, day) do update set count = ai_usage.count + 1
    returning count into used;

    if used > p_user_limit then
        update ai_usage set count = count - 1 where user_id = p_user and day = current_date;
        return jsonb_build_object('status', 'user_limit', 'used', p_user_limit);
    end if;

    return jsonb_build_object('status', 'ok', 'used', used);
end;
$$;

revoke all on function public.claim_ai_request(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_ai_request(uuid, integer, integer) to service_role;
