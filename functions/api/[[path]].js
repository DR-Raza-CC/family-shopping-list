// Family Shopping List – API (Cloudflare Pages Function)
// Needs a KV namespace bound as SHOP.
const json = (d, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

async function sha(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}
const rand = () => [...crypto.getRandomValues(new Uint8Array(24))].map(x => x.toString(16).padStart(2, '0')).join('');
const cleanCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const TOKEN_TTL = 60 * 60 * 24 * 365;

export async function onRequest({ request, env, params }) {
  const KV = env.SHOP;
  const path = (params.path || []).join('/');
  const m = request.method;
  if (path === 'ping') return json({ ok: true, storage: !!KV });
  if (!KV) return json({ error: 'Storage (KV binding SHOP) is not connected' }, 500);

  let body = {};
  if (m === 'POST' || m === 'PUT') { try { body = await request.json(); } catch { body = {}; } }

  if (path === 'register' && m === 'POST') {
    const code = cleanCode(body.code);
    if (code.length < 4 || code.length > 20) return json({ error: 'Family code must be 4–20 letters or numbers' }, 400);
    if (!body.password || String(body.password).length < 4) return json({ error: 'Password must be at least 4 characters' }, 400);
    if (await KV.get('fam:' + code)) return json({ error: 'That family code is taken – try another' }, 409);
    const salt = rand();
    await KV.put('fam:' + code, JSON.stringify({ salt, hash: await sha(salt + body.password), created: Date.now() }));
    const state = { ...(body.state || {}), v: 1 };
    await KV.put('state:' + code, JSON.stringify(state));
    const token = rand();
    await KV.put('tok:' + token, code, { expirationTtl: TOKEN_TTL });
    return json({ token, code, state });
  }

  if (path === 'login' && m === 'POST') {
    const code = cleanCode(body.code);
    const fam = await KV.get('fam:' + code, 'json');
    if (!fam || (await sha(fam.salt + (body.password || ''))) !== fam.hash) return json({ error: 'Family code or password is wrong' }, 403);
    const token = rand();
    await KV.put('tok:' + token, code, { expirationTtl: TOKEN_TTL });
    return json({ token, code, state: await KV.get('state:' + code, 'json') });
  }

  // Everything below needs a signed-in family
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const code = token ? await KV.get('tok:' + token) : null;
  if (!code) return json({ error: 'Please sign in again' }, 401);

  if (path === 'state' && m === 'GET') return json({ state: await KV.get('state:' + code, 'json') });

  if (path === 'state' && m === 'PUT') {
    const cur = await KV.get('state:' + code, 'json');
    if (!body.state || cur.v !== body.v) return json({ conflict: true, state: cur }, 409);
    const next = { ...body.state, v: cur.v + 1 };
    await KV.put('state:' + code, JSON.stringify(next));
    return json({ state: next });
  }

  if (path === 'ai' && m === 'POST') return aiList(env, body);

  if (path === 'logout' && m === 'POST') { await KV.delete('tok:' + token); return json({ ok: true }); }

  return json({ error: 'Not found' }, 404);
}

// ---------- AI: photo of an item / recipe / weekly meal plan -> shopping items ----------
const MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';
const SYS = 'You help a UK family build a supermarket shopping list. Use UK grocery words (courgette, coriander, mince, double cream). Reply with ONE JSON object only – no markdown, no commentary.';
const ITEM_SHAPE = '{"title":"","items":[{"name":"short generic list name, e.g. Chicken thighs","qty":1,"amount":"how much to buy, e.g. 1kg","for":"which meal(s) need it, or empty","staple":false}]}';
function promptFor(kind, people) {
  if (kind === 'item') return 'Identify the grocery product in this photo. Return {"title":"","items":[{"name":"short generic list name, e.g. Bread","product":"brand, product and size as printed on the pack, e.g. Warburtons Toastie White Bread 800g","size":800,"unit":"one of each|eggs|pack|rolls|g|kg|ml|L|pints","qty":1}]}. If you cannot tell the brand, give the best plain description.';
  const base = `List everything to buy for ${people} people. Combine duplicates into one line with a total amount. Round to sensible shop sizes. Mark cupboard basics most homes already have (salt, pepper, cooking oil, water, sugar, plain flour, common dried spices) as "staple":true. Return ${ITEM_SHAPE}`;
  if (kind === 'recipe') return 'This is a recipe (photo or text). Scale it if needed. ' + base + ' Put the recipe name in "title".';
  return 'This is a weekly meal plan (photo or text). Work out the ingredients for every meal listed. ' + base + ' Put a short summary like "7 dinners" in "title".';
}
function parseJSON(t) {
  if (t && typeof t === 'object') return t;
  t = String(t || '').replace(/```(json)?/gi, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b < a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}
async function aiList(env, body) {
  if (!env.AI) return json({ error: 'Photo reading isn’t switched on yet – add the Workers AI binding called AI.' }, 501);
  const kind = ['item', 'recipe', 'plan'].includes(body.kind) ? body.kind : 'plan';
  const people = Math.min(20, Math.max(1, Math.round(+body.people || 4)));
  const img = typeof body.image === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(body.image) ? body.image : null;
  if (img && img.length > 3_000_000) return json({ error: 'That photo is too big – try again' }, 413);
  const text = String(body.text || '').slice(0, 5000);
  if (!img && !text.trim()) return json({ error: 'Add a photo or type something first' }, 400);
  const content = [{ type: 'text', text: promptFor(kind, people) + (text ? '\n\nThe family wrote:\n' + text : '') }];
  if (img) content.push({ type: 'image_url', image_url: { url: img } });
  let out;
  try {
    const r = await env.AI.run(MODEL, { messages: [{ role: 'system', content: SYS }, { role: 'user', content }], max_tokens: 2000, temperature: 0.2 });
    out = parseJSON(r && (r.response ?? r.result ?? r));
  } catch (e) { return json({ error: 'Couldn’t read that just now – try again' }, 502); }
  if (!out || !Array.isArray(out.items)) return json({ error: 'I couldn’t find any items – try a clearer photo' }, 422);
  const items = out.items.slice(0, 80).map(i => ({
    name: String(i.name || '').trim().slice(0, 60),
    qty: Math.min(20, Math.max(1, Math.round(+i.qty || 1))),
    amount: String(i.amount || '').slice(0, 30),
    for: String(i.for || '').slice(0, 60),
    staple: !!i.staple,
    product: i.product ? String(i.product).slice(0, 90) : undefined,
    size: +i.size || undefined,
    unit: ['each', 'eggs', 'pack', 'rolls', 'g', 'kg', 'ml', 'L', 'pints'].includes(i.unit) ? i.unit : undefined,
  })).filter(i => i.name);
  return json({ kind, title: String(out.title || '').slice(0, 80), items });
}
