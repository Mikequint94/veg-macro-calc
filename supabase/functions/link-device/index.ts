// Signs a second device into an account with a short code instead of an email.
// "create": a signed-in device gets a code (single use, expires in 10 minutes).
// "redeem": the new device trades the code for a one-time login token, which it verifies with Supabase Auth.
// Needed for iPhone Home Screen apps, which can't receive email links, and it skips the email rate limit.
// Deploy with JWT verification off: "redeem" comes from a device that isn't signed in yet.
import { createClient } from 'npm:@supabase/supabase-js@2';

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? 'https://mikequint94.github.io')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I/L
const CODE_LENGTH = 8;
const CODE_TTL_MS = 10 * 60 * 1000;

class HttpError extends Error {
    constructor(public status: number, message: string) {
        super(message);
    }
}

function corsHeaders(origin: string) {
    return {
        'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Vary': 'Origin'
    };
}

// Rejection sampling so every character is equally likely.
function newCode() {
    const limit = 256 - (256 % CODE_ALPHABET.length);
    let code = '';
    while (code.length < CODE_LENGTH) {
        for (const b of crypto.getRandomValues(new Uint8Array(CODE_LENGTH))) {
            if (b < limit && code.length < CODE_LENGTH) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
        }
    }
    return code;
}

Deno.serve(async (req) => {
    const origin = req.headers.get('Origin') ?? '';
    const headers = { ...corsHeaders(origin), 'Content-Type': 'application/json' };
    const reply = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status, headers });

    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(origin) });

    try {
        if (!ALLOWED_ORIGINS.includes(origin)) throw new HttpError(403, 'This app is not allowed to link devices.');
        if (req.method !== 'POST') throw new HttpError(405, 'Use POST.');

        const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
            auth: { persistSession: false }
        });
        const body = await req.json().catch(() => null);

        if (body?.action === 'create') {
            const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
            const { data: userData } = await admin.auth.getUser(token);
            const user = userData?.user;
            if (!user?.email) throw new HttpError(401, 'Sign in on this device first.');

            // Creates a one-time login token for this account without sending an email.
            const { data: link, error: linkError } = await admin.auth.admin.generateLink({ type: 'magiclink', email: user.email });
            const tokenHash = link?.properties?.hashed_token;
            if (linkError || !tokenHash) throw new HttpError(500, 'Could not create a sign-in code.');

            // One live code per account, and clear out expired ones while we're here.
            await admin.from('device_link_codes').delete().eq('user_id', user.id);
            await admin.from('device_link_codes').delete().lt('expires_at', new Date().toISOString());

            const code = newCode();
            const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();
            const { error: insertError } = await admin.from('device_link_codes')
                .insert({ code, user_id: user.id, token_hash: tokenHash, expires_at: expiresAt });
            if (insertError) throw new HttpError(500, 'Could not save the sign-in code.');
            return reply(200, { code, expiresAt });
        }

        if (body?.action === 'redeem') {
            const code = String(body.code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
            if (code.length !== CODE_LENGTH) throw new HttpError(400, `Enter the ${CODE_LENGTH}-character code.`);
            // Deleting on read makes each code single use.
            const { data: row } = await admin.from('device_link_codes')
                .delete()
                .eq('code', code)
                .select('token_hash, expires_at')
                .maybeSingle();
            if (!row || Date.parse(row.expires_at) < Date.now()) {
                throw new HttpError(400, 'That code is wrong or has expired. Get a new one on your other device.');
            }
            return reply(200, { tokenHash: row.token_hash });
        }

        throw new HttpError(400, 'Unknown request type.');
    } catch (err) {
        const status = err instanceof HttpError ? err.status : 500;
        if (status === 500) console.error(err);
        return reply(status, { error: err instanceof HttpError ? err.message : 'Something went wrong.' });
    }
});
