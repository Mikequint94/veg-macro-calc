// Proxies NutriPulse's AI nutrition requests to Gemini so the API key never reaches the browser.
// Safeguards: signed-in users only, allowed origins only, fixed prompt + schema (not a general
// Gemini relay), input size caps, and per-user + app-wide daily limits.
import { createClient } from 'npm:@supabase/supabase-js@2';

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? 'https://mikequint94.github.io')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);
const MODEL = 'gemini-3-flash-preview';
const USER_DAILY_LIMIT = Number(Deno.env.get('AI_USER_DAILY_LIMIT') ?? 25);
const GLOBAL_DAILY_LIMIT = Number(Deno.env.get('AI_GLOBAL_DAILY_LIMIT') ?? 400);
const MAX_IMAGE_BASE64_CHARS = 4_000_000; // about 3 MB of image
const MAX_DESCRIPTION_CHARS = 1000;
const MAX_HINT_CHARS = 120;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const CATEGORIES = ['PlantPro', 'DairyEggs', 'Legumes', 'Grains', 'Produce', 'FatsSeeds', 'MealPrep', 'Snacks'];

const RESPONSE_SCHEMA = {
    type: 'OBJECT',
    properties: {
        foodName: { type: 'STRING' },
        servingDesc: { type: 'STRING' },
        grams: { type: 'NUMBER' },
        cal: { type: 'NUMBER' },
        p: { type: 'NUMBER' },
        c: { type: 'NUMBER' },
        f: { type: 'NUMBER' },
        fiber: { type: 'NUMBER' },
        isVegetarian: { type: 'BOOLEAN' },
        vegetarianNote: { type: 'STRING' },
        suggestedCategory: { type: 'STRING', enum: CATEGORIES },
        emoji: { type: 'STRING' }
    },
    required: ['foodName', 'cal', 'p', 'c', 'f', 'isVegetarian']
};

function fieldSpec(isDescribe: boolean) {
    return `
Strictly return a valid JSON object matching the requested schema:
- "foodName": ${isDescribe ? 'Short, descriptive name for the meal (include the restaurant if mentioned).' : 'Exact or best identified product name (use user hint if accurate, or read label title/brand).'}
- "servingDesc": Natural serving description (e.g. ${isDescribe ? '"1 bowl", "3/4 burrito", "2 slices"' : '"1 cup", "2 slices", "1 bar", "100g"'}).
- "grams": Estimated weight in grams (number only, e.g. 85, 240, 100).${isDescribe ? '' : ' Default to 100 if not stated.'}
- "cal": Calories per serving (number).
- "p": Protein in grams per serving (number, rounded to 1 decimal).
- "c": Total Carbohydrates in grams per serving (number, rounded to 1 decimal).
- "f": Total Fat in grams per serving (number, rounded to 1 decimal).
- "fiber": Dietary Fiber in grams per serving (number, rounded to 1 decimal, 0 if ${isDescribe ? 'negligible' : 'not listed'}).
- "isVegetarian": Boolean (true if meatless/vegetarian; false if meat, poultry, fish, gelatin, lard, or slaughter animal products are detected).
- "vegetarianNote": Concise explanation of vegetarian status${isDescribe ? ', plus a brief note on the main assumptions behind the estimate (portion size, cooking oil, etc.)' : ' (e.g. "100% vegetarian friendly", or highlight any flagged non-vegetarian ingredients)'}.
- "suggestedCategory": One of ${JSON.stringify(CATEGORIES)} ("Snacks" covers snacks, sweets, and drinks).
- "emoji": The single most fitting food emoji for this item (e.g. 🌯 for a burrito, 🍕 for pizza, 🥗 for a salad, ☕ for a latte).
`;
}

function buildParts(body: Record<string, unknown>) {
    if (body.mode === 'describe') {
        const description = String(body.description ?? '').trim();
        if (!description) throw new HttpError(400, 'Describe what you ate first.');
        if (description.length > MAX_DESCRIPTION_CHARS) throw new HttpError(400, `Keep the description under ${MAX_DESCRIPTION_CHARS} characters.`);
        return [{
            text: `
Estimate the nutrition for this meal for an interactive 100% vegetarian macro calculator.
The user ate this (often a restaurant meal with no published label):
"""${description}"""

Use published restaurant nutrition data if you know it; otherwise estimate from typical recipes and portion sizes.
Restaurant portions usually include more oil and butter than home cooking, so account for that.
Values should cover the full amount described as one serving (e.g. if they ate 3/4 of a dish, report 3/4 of it).
${fieldSpec(true)}`
        }];
    }

    if (body.mode === 'label') {
        const image = body.image as { mimeType?: string; data?: string } | undefined;
        if (!image?.data || !IMAGE_TYPES.includes(image.mimeType ?? '')) throw new HttpError(400, 'Send a JPEG, PNG or WebP photo.');
        if (image.data.length > MAX_IMAGE_BASE64_CHARS) throw new HttpError(413, 'That photo is too large.');
        const hint = String(body.hint ?? '').trim().slice(0, MAX_HINT_CHARS);
        return [
            {
                text: `
Analyze this Nutrition Facts label image for an interactive 100% vegetarian macro calculator.
${hint ? `The user provided this optional item title hint: "${hint}".` : ''}
${fieldSpec(false)}`
            },
            { inlineData: { mimeType: image.mimeType, data: image.data } }
        ];
    }

    throw new HttpError(400, 'Unknown request type.');
}

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

Deno.serve(async (req) => {
    const origin = req.headers.get('Origin') ?? '';
    const headers = { ...corsHeaders(origin), 'Content-Type': 'application/json' };
    const reply = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status, headers });

    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(origin) });

    try {
        if (!ALLOWED_ORIGINS.includes(origin)) throw new HttpError(403, 'This app is not allowed to use AI features.');
        if (req.method !== 'POST') throw new HttpError(405, 'Use POST.');

        const geminiKey = Deno.env.get('GEMINI_API_KEY');
        if (!geminiKey) throw new HttpError(500, 'AI is not configured yet.');

        const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
            auth: { persistSession: false }
        });
        const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
        const { data: userData } = await admin.auth.getUser(token);
        const user = userData?.user;
        if (!user) throw new HttpError(401, 'Sign in to use AI scanning.');

        const body = await req.json().catch(() => null);
        if (!body || typeof body !== 'object') throw new HttpError(400, 'Invalid request.');
        const parts = buildParts(body);

        const { data: verdict, error: claimError } = await admin.rpc('claim_ai_request', {
            p_user: user.id,
            p_user_limit: USER_DAILY_LIMIT,
            p_global_limit: GLOBAL_DAILY_LIMIT
        });
        if (claimError) throw new HttpError(500, 'Could not check your AI allowance.');
        if (verdict?.status === 'user_limit') {
            throw new HttpError(429, `You've used all ${USER_DAILY_LIMIT} AI scans for today. They reset at midnight UTC.`);
        }
        if (verdict?.status === 'global_limit') {
            throw new HttpError(429, 'AI scanning has hit its daily limit for everyone. Try again tomorrow.');
        }

        const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
            body: JSON.stringify({
                contents: [{ role: 'user', parts }],
                generationConfig: { responseMimeType: 'application/json', responseSchema: RESPONSE_SCHEMA }
            })
        });
        if (!geminiRes.ok) {
            console.error('Gemini error', geminiRes.status, await geminiRes.text());
            throw new HttpError(502, geminiRes.status === 429 ? 'The AI service is busy. Try again in a minute.' : 'The AI service had a problem. Try again.');
        }
        const geminiJson = await geminiRes.json();
        const text = geminiJson.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) throw new HttpError(502, 'The AI could not read that. Try a clearer photo or more detail.');

        return reply(200, { result: JSON.parse(text), remaining: Math.max(0, USER_DAILY_LIMIT - (verdict?.used ?? 0)) });
    } catch (err) {
        const status = err instanceof HttpError ? err.status : 500;
        if (status === 500) console.error(err);
        return reply(status, { error: err instanceof HttpError ? err.message : 'Something went wrong.' });
    }
});
