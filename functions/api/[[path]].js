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

  if (path === 'logout' && m === 'POST') { await KV.delete('tok:' + token); return json({ ok: true }); }

  return json({ error: 'Not found' }, 404);
}
