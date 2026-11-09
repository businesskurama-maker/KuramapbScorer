// bb-login: a signed-in phone approves a "sign in this screen" request shown as a QR on the Basketball portal.
// The phone sends its own access token; we create a NEW session for the same account (magic-link token verified
// server-side) and park it on the request row. The screen collects it once with its private secret (bb_login_poll).
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'METHOD' }, 405);
  let body: { id?: string; deny?: boolean } = {};
  try { body = await req.json(); } catch { return json({ ok: false, error: 'BAD_BODY' }, 400); }
  if (!body.id || !/^[0-9a-f-]{36}$/i.test(body.id)) return json({ ok: false, error: 'BAD_ID' }, 400);

  const URL = Deno.env.get('SUPABASE_URL')!;
  const admin = createClient(URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data: row, error: rowErr } = await admin.from('bb_logins').select('id,status,expires_at,test_email').eq('id', body.id).maybeSingle();
  if (rowErr) return json({ ok: false, error: rowErr.message }, 500);
  if (!row) return json({ ok: false, error: 'MISSING' }, 404);
  if (row.status !== 'pending') return json({ ok: false, error: 'USED' }, 409);
  if (new Date(row.expires_at).getTime() < Date.now()) return json({ ok: false, error: 'EXPIRED' }, 410);

  // who approves: the signed-in phone (test rows can only be created directly in the database)
  let email = row.test_email as string | null;
  if (!email) {
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: u, error: uErr } = await admin.auth.getUser(jwt);
    if (uErr || !u?.user?.email) return json({ ok: false, error: 'SIGN_IN_REQUIRED' }, 401);
    email = u.user.email;
  }
  if (body.deny) { await admin.from('bb_logins').update({ status: 'denied' }).eq('id', row.id).eq('status', 'pending'); return json({ ok: true, denied: true }); }

  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  if (linkErr || !link?.properties?.hashed_token) return json({ ok: false, error: 'LINK: ' + (linkErr?.message || 'no token') }, 500);
  const pub = createClient(URL, Deno.env.get('SUPABASE_ANON_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
  let { data: v, error: vErr } = await pub.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'magiclink' });
  if (vErr || !v?.session) {
    const again = await pub.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'email' });
    v = again.data; vErr = again.error;
  }
  if (vErr || !v?.session) return json({ ok: false, error: 'VERIFY: ' + (vErr?.message || 'no session') }, 500);

  const { error: upErr } = await admin.from('bb_logins').update({
    status: 'approved', email, approved_at: new Date().toISOString(),
    session: { access_token: v.session.access_token, refresh_token: v.session.refresh_token },
  }).eq('id', row.id).eq('status', 'pending');
  if (upErr) return json({ ok: false, error: upErr.message }, 500);
  return json({ ok: true, email });
});
