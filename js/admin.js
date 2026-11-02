(function () {
  const $ = (id) => document.getElementById(id);
  const { esc } = PBCommon;
  let users = [];

  function show(id) {
    ['needLogin', 'notAdmin', 'notConfigured', 'panel'].forEach((k) => $(k).classList.toggle('hidden', k !== id));
  }
  function fmt(d) { return d ? new Date(d).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'; }
  function msg(t, kind) { const m = $('tMsg'); m.textContent = t; m.className = 'msg ' + (kind || ''); }

  function renderUsers() {
    const q = $('search').value.trim().toLowerCase();
    const list = users.filter((u) => !q || (u.email || '').includes(q) || (u.full_name || '').toLowerCase().includes(q));
    $('rows').innerHTML = list.map((u) => {
      const active = u.pass_until && new Date(u.pass_until) > new Date();
      return '<tr>' +
        '<td><div class="u">' + (u.avatar_url ? '<img src="' + esc(u.avatar_url) + '" alt="">' : '<img alt="">') +
        '<div><b>' + esc(u.full_name || '—') + (u.is_admin ? ' · admin' : '') + '</b><small>' + esc(u.email || '') + '</small></div></div></td>' +
        '<td class="num">' + u.credits + '</td>' +
        '<td class="' + (active ? 'pass-on' : '') + '">' + (active ? 'until ' + fmt(u.pass_until) : '—') + '</td>' +
        '<td><div class="quick">' + [1, 5, 10].map((n) => '<button data-e="' + esc(u.email) + '" data-n="' + n + '">+' + n + '</button>').join('') + '</div></td>' +
        '</tr>';
    }).join('') || '<tr><td colspan="4" style="color:var(--ink-3)">No users yet. Users appear after their first Google sign-in.</td></tr>';
    $('rows').querySelectorAll('button[data-e]').forEach((b) => b.onclick = () => add(b.dataset.e, Number(b.dataset.n), 'Quick top-up'));
  }

  async function loadAll() {
    try {
      users = await PBAuth.listUsers();
      renderUsers();
      const byId = Object.fromEntries(users.map((u) => [u.id, u]));
      const rows = await PBAuth.ledger(40);
      $('ledger').innerHTML = rows.map((r) => '<tr><td>' + fmt(r.created_at) + '</td><td>' + esc((byId[r.user_id] && byId[r.user_id].email) || r.user_id.slice(0, 8)) + '</td>' +
        '<td class="num ' + (r.delta > 0 ? 'delta-pos' : 'delta-neg') + '">' + (r.delta > 0 ? '+' : '') + r.delta + '</td><td>' + esc(r.reason) + '</td></tr>').join('') ||
        '<tr><td colspan="4" style="color:var(--ink-3)">No activity yet.</td></tr>';
    } catch (e) { msg('Could not load: ' + e.message, 'bad'); }
  }

  async function add(email, amount, note) {
    email = String(email || '').trim().toLowerCase();
    if (!email) return msg('Enter the user’s Google email.', 'bad');
    if (!Number.isInteger(amount) || amount === 0) return msg('Enter a whole number of credits (not 0).', 'bad');
    msg('Saving…');
    try {
      const bal = await PBAuth.addCredits(email, amount, note);
      msg((amount > 0 ? 'Added ' + amount : 'Removed ' + -amount) + ' credit' + (Math.abs(amount) === 1 ? '' : 's') + ' · ' + email + ' now has ' + bal + '.', 'ok');
      loadAll();
    } catch (e) {
      const m = e.message;
      msg(m === 'USER_NOT_FOUND' ? email + ' has not signed in yet. Ask them to scan the scoreboard QR and sign in with Google once.' :
        m === 'NOT_ADMIN' ? 'Your account is not an admin.' : 'Error: ' + m, 'bad');
    }
  }

  $('tGo').onclick = () => add($('tEmail').value, parseInt($('tAmount').value, 10), $('tNote').value);
  $('search').oninput = renderUsers;
  $('reload').onclick = loadAll;
  $('loginBtn').onclick = () => PBAuth.signIn();
  $('logout').onclick = $('logout2').onclick = async () => { await PBAuth.signOut(); };

  PBAuth.onChange(() => {
    const u = PBAuth.user, p = PBAuth.profile;
    $('whoTxt').textContent = u ? u.email : 'Signed out';
    $('who').classList.toggle('ok', !!(p && p.is_admin));
    if (!PBAuth.enabled) return show('notConfigured');
    if (!u) return show('needLogin');
    if (!p) return;                       // still loading
    if (!p.is_admin) { $('notAdminTxt').textContent = u.email + ' does not have admin access.'; return show('notAdmin'); }
    show('panel'); loadAll();
  });
  PBAuth.init().catch((e) => { $('whoTxt').textContent = 'Error'; msg(String(e.message || e), 'bad'); });
})();
