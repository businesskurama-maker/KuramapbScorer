// donation-alert: called by a database trigger when a player submits a donation reference.
// Sends a push notification (with the pending count for the app badge) to every owner device that turned on alerts.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import webpush from 'npm:web-push@3.6.7';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ ok: false }, 405);
  let id = 0;
  try { id = Number((await req.json()).id); } catch { return json({ ok: false, error: 'bad body' }, 400); }
  if (!id) return json({ ok: false, error: 'no id' }, 400);

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

  // Claim the donation once: only a pending, not-yet-announced donation from the last 10 minutes sends an alert.
  const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { data: claimed, error: claimErr } = await sb.from('purchases')
    .update({ notified_at: new Date().toISOString() })
    .eq('id', id).eq('status', 'pending').is('notified_at', null).gte('created_at', since)
    .select('id,user_id,package,hours,amount_php,reference').maybeSingle();
  if (claimErr) return json({ ok: false, error: claimErr.message }, 500);
  if (!claimed) return json({ ok: true, skipped: true });

  const [{ data: prof }, { count }, { data: cfg }, { data: subs }] = await Promise.all([
    sb.from('profiles').select('email,full_name').eq('id', claimed.user_id).maybeSingle(),
    sb.from('purchases').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    sb.from('push_config').select('vapid_public,vapid_private,vapid_subject').eq('id', 1).single(),
    sb.from('push_subscriptions').select('id,endpoint,p256dh,auth'),
  ]);
  if (!cfg || !subs?.length) return json({ ok: true, sent: 0 });

  webpush.setVapidDetails(cfg.vapid_subject, cfg.vapid_public, cfg.vapid_private);
  const who = prof?.full_name || prof?.email || 'A player';
  const payload = JSON.stringify({
    title: 'New donation · PHP ' + claimed.amount_php,
    body: who + ' · ' + claimed.package + ' · ref …' + claimed.reference + '\nTap to check and approve.',
    count: count ?? 1,
    url: '/owner/',
    tag: 'donation-' + claimed.id,
  });

  let sent = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 3600, urgency: 'high' });
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await sb.from('push_subscriptions').delete().eq('id', s.id);   // device unsubscribed
    }
  }));
  return json({ ok: true, sent });
});
