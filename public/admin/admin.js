(() => {
  const $ = (id) => document.getElementById(id);
  // eigen dialogen: de tekst (ook met variabelen) wordt in de gekozen taal getoond
  const confirmT = (m) => confirm(I18n.tr(m));
  const promptT = (m, v) => prompt(I18n.tr(m), v);
  I18n.mountPrefs($('prefs'));
  const NS = 'http://www.w3.org/2000/svg';
  const show = (id) => {
    for (const v of ['v-setup', 'v-login', 'v-edit']) $(v).classList.toggle('hidden', v !== id);
  };

  async function api(url, opts = {}) {
    const res = await fetch(url, {
      credentials: 'same-origin',
      ...opts,
      headers: opts.body && typeof opts.body === 'string' ? { 'Content-Type': 'application/json', ...opts.headers } : opts.headers,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401 && opts.expectAuth) { boot(); }
      throw new Error(data.error || `Fout ${res.status}`);
    }
    return data;
  }
  if (Wijk.BETA) Wijk.setHeading($('admin-title').querySelector('.brand-text'), 'Beheer');
  const post = (url, body, extra) => api(url, { method: 'POST', body: JSON.stringify(body || {}), ...extra });

  function toast(msg) {
    const t = document.createElement('div');
    t.className = 'toast'; t.textContent = msg;
    document.body.append(t);
    setTimeout(() => t.remove(), 2500);
  }

  const friendly = (err) =>
    err && err.cancelled ? '' : err && err.name === 'NotAllowedError' ? 'Geannuleerd of niet toegestaan door het apparaat.' : err.message;

  // ---------- inloggen, installatie en uitnodigingen ----------
  // De sessie zoals /api/auth/status hem geeft; user is de ingelogde gebruiker (met strong: mag de eigen inlog wijzigen).
  let session = { method: null, passwordEnabled: false, passkeysEnabled: false, passkey: { available: false, reason: '' }, user: null };
  const locked = () => !session.user?.strong;
  const cancelled = () => Object.assign(new Error(''), { cancelled: true });
  const passkeyHere = () => !!(session.passkey?.available && window.PublicKeyCredential && window.isSecureContext);
  const passkeyWhy = () => (session.passkey?.available ? 'Deze browser ondersteunt geen passkeys (HTTPS is vereist).' : session.passkey?.reason || '');
  const inviteToken = () => (location.hash.match(/^#invite=([A-Za-z0-9_-]{43})$/) || [])[1] || null;
  const dropInviteHash = () => history.replaceState(null, '', location.pathname + location.search);

  async function registerPasskey(body) {
    const { challengeId, options } = await post('/api/auth/register/options', body);
    const response = await SimpleWebAuthnBrowser.startRegistration({ optionsJSON: options });
    await post('/api/auth/register/verify', { challengeId, response });
  }

  // Werkt de naam van de eigen bestaande passkeys bij in de wachtwoordbeheerder (WebAuthn Signal API). Alleen browsers die
  // dat kunnen (bijvoorbeeld Chrome); stil, zonder melding als het niet lukt.
  function signalPasskeyName(details) {
    const pkc = window.PublicKeyCredential;
    if (!details || typeof pkc?.signalCurrentUserDetails !== 'function') return;
    pkc.signalCurrentUserDetails(details).catch(() => {});
  }

  async function login() {
    const { challengeId, options } = await post('/api/auth/login/options');
    const response = await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: options });
    await post('/api/auth/login/verify', { challengeId, response });
  }

  // Eén kaart voor de eerste installatie én voor een uitnodiging: naam, keuze passkey of wachtwoord, daarna optioneel MFA.
  let wiz = { invite: null, kind: 'setup' };
  let wizPassword = ''; // het zojuist gekozen wachtwoord: de bevestiging om MFA aan te zetten, daarna vergeten
  const wizMethod = () => document.querySelector('input[name="s-method"]:checked')?.value || null;

  function showWizard({ invite = null, info = null } = {}) {
    wiz = { invite, kind: info ? info.kind : 'setup' };
    show('v-setup');
    $('s-step-account').classList.remove('hidden');
    $('s-step-mfa').classList.add('hidden');
    $('s-account').classList.remove('hidden');
    $('s-invite-back').classList.add('hidden');
    $('s-err').textContent = '';
    document.querySelectorAll('#v-setup .s-setup').forEach((el) => el.classList.toggle('hidden', !!invite));
    document.querySelectorAll('#v-setup .s-invite').forEach((el) => el.classList.toggle('hidden', !invite));
    if ($('s-name').value === 'Mijn apparaat') $('s-name').value = I18n.tr('Mijn apparaat');
    if (!invite) {
      $('s-title').textContent = 'Eerste keer instellen';
      if (!$('s-user').value) $('s-user').value = 'beheerder';
      $('s-user').readOnly = false;
    } else if (info.kind === 'reset') {
      $('s-title').textContent = 'Nieuwe inlog instellen';
      $('s-invite-text').textContent = `Stel een nieuwe inlog in voor ${info.username}. Je oude passkeys, wachtwoord en MFA vervallen zodra je klaar bent.`;
      $('s-user').value = info.username;
      $('s-user').readOnly = true;
    } else {
      $('s-title').textContent = 'Uitnodiging';
      $('s-invite-text').textContent = info.invitedBy
        ? `${info.invitedBy} nodigt je uit voor het beheer van deze kaart. Kies een gebruikersnaam en hoe je wilt inloggen.`
        : 'Je bent uitgenodigd voor het beheer van deze kaart. Kies een gebruikersnaam en hoe je wilt inloggen.';
      $('s-user').value = info.username || '';
      $('s-user').readOnly = false;
    }
    // Een passkey kan alleen via een echte domeinnaam en HTTPS; anders uitleggen waarom niet en het wachtwoord kiezen.
    const pkRadio = document.querySelector('input[name="s-method"][value="passkey"]');
    pkRadio.disabled = !passkeyHere();
    $('s-pk-why').textContent = passkeyHere() ? '' : passkeyWhy();
    document.querySelector(`input[name="s-method"][value="${passkeyHere() ? 'passkey' : 'password'}"]`).checked = true;
    chooseMethod();
  }

  function chooseMethod() {
    const m = wizMethod();
    $('s-pk').classList.toggle('hidden', m !== 'passkey');
    const slot = $('s-pw-slot');
    if (m !== 'password') { slot.replaceChildren(); return; }
    if ($('s-pw')) return;
    slot.append($('s-pw-tpl').content.cloneNode(true));
    $('s-pw').onsubmit = async (e) => {
      e.preventDefault();
      $('s-err').textContent = '';
      const pw = $('s-pw1').value;
      if (pw.length < 10) { $('s-err').textContent = 'Kies een wachtwoord van minimaal 10 tekens.'; return; }
      if (pw !== $('s-pw2').value) { $('s-err').textContent = 'De twee wachtwoorden zijn niet gelijk.'; return; }
      $('s-pw-user').value = $('s-user').value.trim();
      $('s-pw-go').disabled = true;
      try {
        if (wiz.invite) await post('/api/invites/password', { token: wiz.invite, username: $('s-user').value, password: pw });
        else await post('/api/auth/setup/password', { setupToken: $('s-token').value, username: $('s-user').value, password: pw });
        if (wiz.invite) dropInviteHash();
        wizPassword = pw;
        showMfaOffer();
      } catch (err) { $('s-err').textContent = err.message; }
      finally { if ($('s-pw-go')) $('s-pw-go').disabled = false; }
    };
  }
  document.querySelectorAll('input[name="s-method"]').forEach((r) => { r.onchange = chooseMethod; });

  $('s-go').onclick = async () => {
    $('s-err').textContent = '';
    try {
      if (!window.PublicKeyCredential) throw new Error('Deze browser ondersteunt geen passkeys (HTTPS is vereist).');
      const body = { username: $('s-user').value, name: $('s-name').value };
      if (wiz.invite) await registerPasskey({ ...body, invite: wiz.invite });
      else await registerPasskey({ ...body, setupToken: $('s-token').value });
      if (wiz.invite) dropInviteHash();
      boot();
    } catch (e) { $('s-err').textContent = friendly(e); }
  };

  // Na een account met wachtwoord: tweestapsverificatie aanbieden, met een duidelijk "Niet nu".
  function showMfaOffer() {
    $('s-title').textContent = 'Tweestapsverificatie (MFA)';
    $('s-step-account').classList.add('hidden');
    $('s-step-mfa').classList.remove('hidden');
    $('s-mfa-intro').classList.remove('hidden');
    $('s-mfa-choice').classList.remove('hidden');
    $('s-mfa-box').replaceChildren();
    $('s-mfa-yes').focus();
  }
  $('s-mfa-no').onclick = () => { wizPassword = ''; boot(); };
  $('s-mfa-yes').onclick = async () => {
    $('s-mfa-choice').classList.add('hidden');
    $('s-mfa-intro').classList.add('hidden');
    try {
      await mfaEnroll($('s-mfa-box'), { proof: { confirm: { password: wizPassword } }, onDone: () => { wizPassword = ''; boot(); }, onCancel: () => showMfaOffer() });
    } catch (e) {
      showMfaOffer();
      $('s-mfa-box').append(Object.assign(document.createElement('p'), { className: 'error', textContent: e.message }));
    }
  };

  async function showInvite(token) {
    let info = null;
    try {
      const res = await fetch('/api/invites/info', { headers: { 'X-Invite-Token': token }, credentials: 'same-origin' });
      if (res.ok) info = await res.json();
    } catch { /* hieronder als ongeldig behandeld */ }
    if (!info) {
      show('v-setup');
      $('s-title').textContent = 'Uitnodiging';
      $('s-step-mfa').classList.add('hidden');
      $('s-step-account').classList.remove('hidden');
      document.querySelectorAll('#v-setup .s-setup').forEach((el) => el.classList.add('hidden'));
      $('s-account').classList.add('hidden');
      $('s-invite-text').classList.remove('hidden');
      $('s-invite-text').textContent = 'Deze link is ongeldig of verlopen. Vraag de eigenaar van het beheer om een nieuwe link.';
      $('s-err').textContent = '';
      $('s-invite-back').classList.remove('hidden');
      dropInviteHash();
      return;
    }
    session = { ...session, passkey: info.passkey };
    showWizard({ invite: token, info });
  }

  function showLogin(st) {
    show('v-login');
    const pk = st.passkeysEnabled;
    $('l-err').textContent = '';
    $('l-go').classList.toggle('hidden', !pk);
    $('l-intro').textContent = pk ? 'Log in met je passkey (vingerafdruk, gezicht, pincode of beveiligingssleutel).' : 'Log in met je gebruikersnaam en wachtwoord.';
    $('l-intro').classList.remove('hidden');
    mountPwLogin(st.passwordEnabled, !pk);
  }

  $('l-go').onclick = async () => {
    $('l-err').textContent = '';
    try { await login(); boot(); } catch (e) { $('l-err').textContent = friendly(e); }
  };
  // Het inlogformulier met wachtwoordveld bestaat alleen op het inlogscherm (niet in de editor).
  function mountPwLogin(enabled, only = false) {
    const slot = $('pw-form-slot');
    slot.replaceChildren();
    if (!enabled) return;
    slot.append($('pw-form-tpl').content.cloneNode(true));
    slot.querySelector('.l-or').classList.toggle('hidden', only);
    $('l-pw-go').classList.toggle('primary', only);
    $('pw-form').onsubmit = async (e) => {
      e.preventDefault();
      $('l-pw-err').textContent = '';
      try {
        const res = await post('/api/auth/password-login', { username: $('l-user').value, password: $('l-pw').value });
        if (res.mfaRequired) mountMfaLogin(res.ticket); else boot();
      } catch (err) { $('l-pw-err').textContent = err.message; }
    };
    if (only) $('l-user').focus();
  }
  // Tweede stap: de code uit de authenticator-app of een herstelcode.
  function mountMfaLogin(ticket) {
    const slot = $('pw-form-slot');
    slot.replaceChildren($('mfa-form-tpl').content.cloneNode(true));
    $('l-go').classList.add('hidden');
    $('l-intro').classList.add('hidden');
    $('mfa-form').onsubmit = async (e) => {
      e.preventDefault();
      $('l-code-err').textContent = '';
      try { await post('/api/auth/mfa-login', { ticket, code: $('l-code').value }); boot(); }
      catch (err) {
        if (/Sessie verlopen/.test(err.message)) { showLogin(session); $('l-pw-err').textContent = err.message; return; }
        $('l-code-err').textContent = err.message;
        $('l-code').select();
      }
    };
    $('l-code-back').onclick = () => showLogin(session);
    $('l-code').focus();
  }

  $('logout').onclick = async () => {
    if (dirty && !confirmT('Er zijn niet-opgeslagen wijzigingen. Toch uitloggen?')) return;
    dirty = false;
    await post('/api/auth/logout');
    location.reload();
  };

  // ---------- bevestigen van gevoelige acties ----------
  // Met een eigen passkey als je die hebt, anders met je huidige wachtwoord (en de MFA-code). Geeft het bewijs terug
  // dat in de body van het verzoek mee moet.
  const confirmWord = () => (session.user?.passkeys ? 'passkey' : 'wachtwoord');
  function syncConfirmLabels() {
    document.querySelectorAll('.confirm-label').forEach((b) => { b.textContent = `Geselecteerde verwijderen (bevestig met ${confirmWord()})`; });
  }
  async function confirmStep() {
    const o = await post('/api/admin/confirm/options');
    if (o.method === 'passkey') {
      const response = await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: o.options });
      return { challengeId: o.challengeId, response };
    }
    return askPassword(o.mfa);
  }
  function askPassword(mfa) {
    const dlg = $('cf-dialog');
    const field = (id, label, type, ac) => {
      const l = document.createElement('label'); l.htmlFor = id; l.textContent = label;
      const i = document.createElement('input'); i.type = type; i.id = id; i.autocomplete = ac; i.maxLength = type === 'password' ? 200 : 24; i.spellcheck = false;
      return [l, i];
    };
    const user = Object.assign(document.createElement('input'), { type: 'text', name: 'username', autocomplete: 'username', hidden: true, value: session.user?.username || '' });
    $('cf-fields').replaceChildren(user, ...field('cf-pw', 'Huidig wachtwoord', 'password', 'current-password'), ...(mfa ? field('cf-code', 'Code uit je authenticator-app (of een herstelcode)', 'text', 'one-time-code') : []));
    $('cf-text').textContent = mfa ? 'Voer ter bevestiging je huidige wachtwoord en een MFA-code in.' : 'Voer ter bevestiging je huidige wachtwoord in.';
    $('cf-err').textContent = '';
    return new Promise((resolve, reject) => {
      const done = (fn) => { dlg.close(); $('cf-fields').replaceChildren(); fn(); };
      $('cf-form').onsubmit = (e) => {
        e.preventDefault();
        if (!$('cf-pw').value) { $('cf-err').textContent = 'Vul je wachtwoord in.'; return; }
        const proof = { confirm: { password: $('cf-pw').value, code: mfa ? $('cf-code').value : undefined } };
        done(() => resolve(proof));
      };
      $('cf-cancel').onclick = () => done(() => reject(cancelled()));
      dlg.oncancel = (e) => { e.preventDefault(); done(() => reject(cancelled())); };
      dlg.showModal();
      $('cf-pw').focus();
    });
  }

  // ---------- MFA instellen (wizard én Instellingen → Beveiliging) ----------
  // Stap 1: geheim + QR-code, stap 2: een code uit de app, stap 3: herstelcodes één keer tonen.
  // proof: de bevestiging (passkey of wachtwoord) die de server vraagt voordat MFA aan mag.
  async function mfaEnroll(box, { proof, onDone, onCancel }) {
    const { challengeId, secret, uri } = await post('/api/admin/mfa/start', proof);
    const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
    const steps = el('ol', { className: 'mfa-steps' },
      el('li', { textContent: 'Open je authenticator-app en scan deze QR-code.' }),
      el('li', { textContent: 'Voer de code van 6 cijfers in die de app toont.' }));
    const qr = el('p', { className: 'mfa-qr' }, el('img', { src: Wijk.qrDataUrl(uri, 400), alt: 'QR-code voor je authenticator-app' }));
    const manual = el('p', { className: 'muted', textContent: 'Lukt scannen niet? Voer deze sleutel in de app in:' });
    const key = el('code', { className: 'mfa-secret', textContent: secret.match(/.{1,4}/g).join(' ') });
    key.setAttribute('data-i18n-skip', '');
    const code = el('input', { type: 'text', id: 'mfa-code', inputMode: 'numeric', autocomplete: 'one-time-code', maxLength: 6, spellcheck: false });
    const err = el('p', { className: 'error' });
    const ok = el('button', { type: 'submit', className: 'primary', textContent: 'MFA aanzetten' });
    const cancel = el('button', { type: 'button', textContent: 'Annuleren', onclick: () => { box.replaceChildren(); onCancel && onCancel(); } });
    const form = el('form', { className: 'mfa-flow', autocomplete: 'off' }, steps, qr, manual, key, el('label', { htmlFor: 'mfa-code', textContent: 'Code uit de app' }), code, err, el('div', { className: 'row' }, ok, cancel));
    form.onsubmit = async (e) => {
      e.preventDefault();
      err.textContent = '';
      ok.disabled = true;
      try {
        const res = await post('/api/admin/mfa/confirm', { challengeId, code: code.value });
        showRecoveryCodes(box, res.recoveryCodes, onDone);
      } catch (ex) { err.textContent = ex.message; code.select(); }
      finally { ok.disabled = false; }
    };
    box.replaceChildren(form);
    code.focus();
  }

  function showRecoveryCodes(box, codes, onDone) {
    const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
    const text = codes.join('\n');
    const list = el('ul', { className: 'rc-list' }, ...codes.map((c) => el('li', {}, el('code', { textContent: c }))));
    list.setAttribute('data-i18n-skip', '');
    const copy = el('button', { type: 'button', textContent: 'Kopiëren' });
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(text); toast('Herstelcodes gekopieerd ✔'); }
      catch { const r = document.createRange(); r.selectNodeContents(list); getSelection().removeAllRanges(); getSelection().addRange(r); }
    };
    const download = el('button', { type: 'button', textContent: 'Downloaden' });
    download.onclick = () => {
      const a = el('a', { href: URL.createObjectURL(new Blob([`${text}\n`], { type: 'text/plain' })), download: 'herstelcodes.txt' });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
    const saved = el('input', { type: 'checkbox', id: 'rc-saved' });
    const next = el('button', { type: 'button', className: 'primary', textContent: 'Klaar', disabled: true });
    saved.onchange = () => { next.disabled = !saved.checked; };
    next.onclick = () => { box.replaceChildren(); onDone && onDone(); };
    box.replaceChildren(
      el('p', { className: 'muted', textContent: 'Tweestapsverificatie staat aan. Bewaar deze herstelcodes op een veilige plek: ben je je telefoon kwijt, dan log je met één van deze codes in. Elke code werkt één keer, en je ziet ze maar één keer.' }),
      list,
      el('div', { className: 'row' }, copy, download),
      el('label', { className: 'rc-check', htmlFor: 'rc-saved' }, saved, el('span', { textContent: 'Ik heb de herstelcodes bewaard' })),
      next,
    );
  }

  // ---------- Instellingen → Beveiliging ----------
  async function renderSecurity() {
    session = await api('/api/auth/status');
    const u = session.user;
    if (!u) return boot();
    syncConfirmLabels();
    const isLocked = locked();
    $('pw-locked').classList.toggle('hidden', !isLocked);
    // account
    $('acc-name').value = u.username;
    $('acc-name').disabled = isLocked;
    $('acc-save').disabled = isLocked;
    $('acc-status').textContent = u.owner ? 'Je bent de eigenaar: jij kunt ook gebruikers uitnodigen en verwijderen.' : 'Je beheert de kaart; gebruikers uitnodigen en verwijderen doet de eigenaar.';
    // wachtwoord
    $('pw-status').textContent = u.password
      ? 'Er is een wachtwoord ingesteld.'
      : 'Er is nog geen wachtwoord ingesteld; inloggen kan alleen met een passkey.';
    $('pw-hint').textContent = u.passkeys
      ? 'Het instellen, wijzigen en verwijderen van het wachtwoord moet je bevestigen met een passkey.'
      : 'Een nieuw wachtwoord bevestig je met je huidige wachtwoord.';
    $('pw-start').textContent = u.password ? 'Wachtwoord wijzigen…' : 'Wachtwoord instellen…';
    $('pw-remove').classList.toggle('hidden', !u.password || !u.passkeys);
    $('pw-edit').classList.toggle('hidden', isLocked);
    if (isLocked) closePwForm();
    // MFA hoort bij het wachtwoord
    $('mfa-card').classList.toggle('hidden', !u.password);
    $('mfa-status').textContent = u.mfa
      ? `Tweestapsverificatie staat aan. Nog ${u.recoveryLeft} herstelcode(s) over.`
      : 'Tweestapsverificatie staat uit. Zet hem aan om bij inloggen met je wachtwoord ook een code uit een authenticator-app te vragen.';
    $('mfa-edit').classList.toggle('hidden', isLocked);
    $('mfa-start').classList.toggle('hidden', !!u.mfa);
    $('mfa-codes').classList.toggle('hidden', !u.mfa);
    $('mfa-off').classList.toggle('hidden', !u.mfa);
    // passkeys
    $('pk-add').disabled = isLocked || !passkeyHere();
    $('pk-name').disabled = isLocked || !passkeyHere();
    $('pk-why').textContent = passkeyHere() ? '' : passkeyWhy();
    $('pk-why').classList.toggle('hidden', passkeyHere());
    const list = await api('/api/admin/passkeys');
    $('pk-list').innerHTML = '';
    if (!list.length) $('pk-list').append(Object.assign(document.createElement('p'), { className: 'muted', textContent: 'Je hebt nog geen passkey.' }));
    for (const p of list) {
      const row = document.createElement('div');
      row.className = 'pk';
      const s = document.createElement('span');
      s.textContent = `${p.name} · ${new Date(p.createdAt).toLocaleDateString(I18n.locale)}`;
      const del = document.createElement('button');
      del.className = 'danger'; del.textContent = 'Verwijder'; del.disabled = (list.length < 2 && !u.password) || isLocked;
      if (list.length < 2 && !u.password) del.title = 'Je kunt je laatste passkey alleen verwijderen als je een wachtwoord hebt ingesteld';
      del.onclick = async () => {
        if (!confirmT(`Passkey "${p.name}" verwijderen?`)) return;
        try { await api(`/api/admin/passkeys/${encodeURIComponent(p.id)}`, { method: 'DELETE' }); renderSecurity(); }
        catch (e) { $('pk-err').textContent = e.message; }
      };
      row.append(s, del);
      $('pk-list').append(row);
    }
  }

  $('acc-save').onclick = async () => {
    $('acc-err').textContent = '';
    try {
      await api('/api/admin/account/username', { method: 'PUT', body: JSON.stringify({ username: $('acc-name').value }) });
      toast('Gebruikersnaam opgeslagen ✔');
      renderSecurity();
    } catch (e) { $('acc-err').textContent = e.message; }
  };

  // De wachtwoordvelden worden pas aangemaakt als je op "Wachtwoord instellen" klikt en daarna weer verwijderd.
  function closePwForm() { $('pw-form-set').replaceChildren(); $('pw-form-set').classList.add('hidden'); $('pw-start').classList.remove('hidden'); }
  $('pw-start').onclick = () => {
    $('pw-err').textContent = '';
    const f = $('pw-form-set');
    const field = (id, label) => {
      const l = document.createElement('label'); l.htmlFor = id; l.textContent = label;
      const i = document.createElement('input');
      i.type = 'password'; i.id = id; i.maxLength = 200; i.autocomplete = 'new-password';
      return [l, i];
    };
    const user = document.createElement('input');
    user.type = 'text'; user.name = 'username'; user.value = session.user?.username || ''; user.autocomplete = 'username'; user.hidden = true;
    const err = document.createElement('p'); err.className = 'error'; err.id = 'pw-set-err';
    const row = document.createElement('div'); row.className = 'row';
    const ok = document.createElement('button'); ok.type = 'submit'; ok.className = 'primary'; ok.textContent = `Opslaan (bevestig met ${confirmWord()})`;
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Annuleren'; cancel.onclick = closePwForm;
    row.append(ok, cancel);
    f.replaceChildren(user, ...field('pw-new', session.user?.password ? 'Nieuw wachtwoord (minimaal 10 tekens)' : 'Wachtwoord (minimaal 10 tekens)'), ...field('pw-new2', 'Herhaal wachtwoord'), err, row);
    f.classList.remove('hidden');
    $('pw-start').classList.add('hidden');
    $('pw-new').focus();
  };
  $('pw-form-set').onsubmit = async (e) => {
    e.preventDefault();
    const err = $('pw-set-err');
    err.textContent = '';
    const pw = $('pw-new').value;
    if (pw.length < 10) { err.textContent = 'Kies een wachtwoord van minimaal 10 tekens.'; return; }
    if (pw !== $('pw-new2').value) { err.textContent = 'De twee wachtwoorden zijn niet gelijk.'; return; }
    try {
      const proof = await confirmStep();
      await api('/api/admin/password', { method: 'PUT', body: JSON.stringify({ ...proof, password: pw }) });
      closePwForm();
      toast('Wachtwoord opgeslagen ✔');
      renderSecurity();
    } catch (ex) { err.textContent = friendly(ex); }
  };
  $('pw-remove').onclick = async () => {
    $('pw-err').textContent = '';
    if (!confirmT('Het wachtwoord verwijderen? Inloggen kan dan alleen nog met een passkey.')) return;
    try {
      const proof = await confirmStep();
      await post('/api/admin/password/remove', proof);
      toast('Wachtwoord verwijderd');
      renderSecurity();
    } catch (e) { $('pw-err').textContent = friendly(e); }
  };

  $('pk-add').onclick = async () => {
    $('pk-err').textContent = '';
    try {
      const proof = session.method === 'pw' ? await confirmStep() : {};
      await registerPasskey({ name: $('pk-name').value, ...proof });
      renderSecurity();
      toast('Passkey toegevoegd');
    } catch (e) { $('pk-err').textContent = friendly(e); }
  };

  const mfaIdle = () => { $('mfa-actions').classList.remove('hidden'); };
  $('mfa-start').onclick = async () => {
    $('mfa-err').textContent = '';
    $('mfa-actions').classList.add('hidden');
    try {
      const proof = await confirmStep();
      await mfaEnroll($('mfa-box'), { proof, onDone: () => { mfaIdle(); renderSecurity(); }, onCancel: mfaIdle });
    } catch (e) { mfaIdle(); $('mfa-err').textContent = friendly(e); }
  };
  $('mfa-codes').onclick = async () => {
    $('mfa-err').textContent = '';
    if (!confirmT('Nieuwe herstelcodes maken? De oude codes werken daarna niet meer.')) return;
    try {
      const proof = await confirmStep();
      const res = await post('/api/admin/mfa/recovery', proof);
      $('mfa-actions').classList.add('hidden');
      showRecoveryCodes($('mfa-box'), res.recoveryCodes, () => { mfaIdle(); renderSecurity(); });
    } catch (e) { $('mfa-err').textContent = friendly(e); }
  };
  $('mfa-off').onclick = async () => {
    $('mfa-err').textContent = '';
    if (!confirmT('Tweestapsverificatie uitzetten? Inloggen kan dan weer met alleen je wachtwoord.')) return;
    try {
      const proof = await confirmStep();
      await post('/api/admin/mfa/disable', proof);
      toast('Tweestapsverificatie staat uit');
      renderSecurity();
    } catch (e) { $('mfa-err').textContent = friendly(e); }
  };

  // ---------- Instellingen → Gebruikers (alleen de eigenaar) ----------
  function showLink(text, url) {
    $('us-link-text').textContent = text;
    $('us-link-url').value = url;
    $('us-link').classList.remove('hidden');
    $('us-link-url').select();
  }
  $('us-copy').onclick = async () => {
    try { await navigator.clipboard.writeText($('us-link-url').value); toast('Link gekopieerd ✔'); }
    catch { $('us-link-url').select(); document.execCommand?.('copy'); }
  };
  $('us-invite').onclick = async () => {
    $('us-err').textContent = '';
    try {
      const inv = await post('/api/admin/users/invites', { username: $('us-name').value }, { expectAuth: true });
      $('us-name').value = '';
      showLink(`Uitnodigingslink, geldig tot ${fmtDay(inv.expiresAt)}:`, inv.url);
      renderUsers();
    } catch (e) { $('us-err').textContent = e.message; }
  };

  async function renderUsers() {
    $('us-err').textContent = '';
    let data;
    try { data = await api('/api/admin/users', { expectAuth: true }); } catch (e) { $('us-err').textContent = e.message; return; }
    const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
    $('us-list').replaceChildren(...data.users.map((u) => {
      const name = el('span', { textContent: u.username });
      name.setAttribute('data-i18n-skip', '');
      const head = el('div', { className: 'us-name' }, name);
      if (u.owner) head.append(el('span', { className: 'us-badge', textContent: 'Eigenaar' }));
      if (u.id === session.user?.id) head.append(el('span', { className: 'us-badge', textContent: 'Jij' }));
      const how = [];
      if (u.passkeys) how.push(el('span', { textContent: `${u.passkeys} passkey(s)` }));
      if (u.password) how.push(el('span', { textContent: 'Wachtwoord' }));
      if (u.mfa) how.push(el('span', { textContent: 'MFA' }));
      if (!how.length) how.push(el('span', { textContent: 'Nog geen inlog' }));
      how.push(el('span', { textContent: `sinds ${fmtDay(u.createdAt)}` }));
      const row = el('div', { className: 'bk-row us-row' }, el('div', { className: 'bk-info' }, head, el('div', { className: 'us-meta' }, ...how)));
      if (!u.owner) {
        const reset = el('button', { type: 'button', textContent: 'Nieuwe inloglink' });
        reset.onclick = async () => {
          try {
            const inv = await post(`/api/admin/users/${encodeURIComponent(u.id)}/reset`, {}, { expectAuth: true });
            showLink(`Inloglink voor ${u.username}, geldig tot ${fmtDay(inv.expiresAt)}. De oude inlog blijft werken tot de nieuwe is ingesteld:`, inv.url);
            renderUsers();
          } catch (e) { $('us-err').textContent = e.message; }
        };
        const del = el('button', { type: 'button', className: 'danger', textContent: 'Verwijderen' });
        del.onclick = async () => {
          if (!confirmT(`${u.username} verwijderen? Die kan daarna niet meer inloggen.`)) return;
          try { await api(`/api/admin/users/${encodeURIComponent(u.id)}`, { method: 'DELETE', expectAuth: true }); toast('Gebruiker verwijderd'); renderUsers(); }
          catch (e) { $('us-err').textContent = e.message; }
        };
        row.append(el('div', { className: 'us-actions' }, reset, del));
      }
      return row;
    }));
    $('us-invites').replaceChildren(...(data.invites.length ? data.invites.map((i) => {
      const name = el('span', { textContent: i.username || '' });
      name.setAttribute('data-i18n-skip', '');
      const what = el('div', { className: 'us-name' }, el('span', { textContent: i.kind === 'reset' ? 'Nieuwe inlog' : 'Uitnodiging' }), name);
      const revoke = el('button', { type: 'button', textContent: 'Intrekken' });
      revoke.onclick = async () => {
        try { await api(`/api/admin/users/invites/${encodeURIComponent(i.id)}`, { method: 'DELETE', expectAuth: true }); $('us-link').classList.add('hidden'); renderUsers(); }
        catch (e) { $('us-err').textContent = e.message; }
      };
      return el('div', { className: 'bk-row us-row' }, el('div', { className: 'bk-info' }, what, el('div', { className: 'us-meta' }, el('span', { textContent: `geldig tot ${fmtDay(i.expiresAt)}` }))), revoke);
    }) : [el('p', { className: 'muted', textContent: 'Geen open uitnodigingen.' })]));
  }

  // ---------- logo & uitleg ----------
  let statsShow = { green: true, red: true, none: true }; // welke statusregels de overlay op de kaart toont (instelling)
  let org = { intro: '', logo: null, logoSmall: null, favicon: null, siteTitle: '', appName: '', appShortName: '', labels: null };
  function renderOrg() {
    $('org-logo').hidden = !org.logo;
    if (org.logo) $('org-logo').src = org.logo.url;
    $('org-remove').disabled = !org.logo;
    $('org-logo-small').hidden = !org.logoSmall;
    if (org.logoSmall) $('org-logo-small').src = org.logoSmall.url;
    $('org-remove-small').disabled = !org.logoSmall;
    $('org-favicon').hidden = !org.favicon;
    if (org.favicon) $('org-favicon').src = org.favicon.url;
    $('org-remove-favicon').disabled = !org.favicon;
    $('org-count').textContent = $('org-intro').value.length;
  }
  const DEFAULT_LABELS = { green: 'Groen', red: 'Rood', none: 'Niet gemarkeerd' };
  // Taalinstellingen: slaan direct op en laden daarna opnieuw, zodat het beheer meteen in de nieuwe taal staat.
  const saveLang = async (patch) => {
    try { await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(patch), expectAuth: true }); location.reload(); }
    catch (e) { $('org-err').textContent = e.message; }
  };
  const langPicker = I18n.picker({ value: I18n.defaultLang, label: 'Standaardtaal', onSelect: (code) => saveLang({ defaultLang: code }) });
  $('org-lang-slot').append(langPicker);
  $('org-multi').onchange = () => saveLang({ multilingual: $('org-multi').checked });
  // ---- Config: teksten per taal ----
  // De velden onder de taalbalk bestaan per taal. Wat je typt blijft per taal bewaard (cfg.drafts) tot je opslaat.
  const FIELD_IDS = { siteTitle: 'org-title', appName: 'org-appname', appShortName: 'org-short', residentInfo: 'org-info', intro: 'org-intro', qrShareText: 'org-share', communityTitle: 'org-ctitle', communityText: 'org-ctext' };
  const WITH_DEFAULT = new Set(['qrShareText', 'communityTitle', 'communityText']); // leeg = standaardtekst: het veld toont die tekst
  const cfg = { st: null, drafts: {}, lang: I18n.defaultLang };
  const cfgLang = () => (I18n.multi ? cfg.lang : I18n.defaultLang); // zonder meertalig bewerk je de standaardtaal
  const draftFrom = (src, l, def) => {
    const lab = src.labels || {};
    return {
      siteTitle: src.siteTitle || '', appName: src.appName || '', appShortName: src.appShortName || '',
      residentInfo: src.residentInfo || '', intro: src.intro || '',
      qrShareText: src.qrShareText || def.shareText[l],
      communityTitle: src.communityTitle || def.community[l].title,
      communityText: src.communityText || def.community[l].text,
      labels: { green: lab.green || '', red: lab.red || '', none: lab.none || '' },
    };
  };
  function storeFields() { // de velden van de getoonde taal naar het concept
    const d = cfg.drafts[cfg.shown];
    if (!d) return;
    for (const [f, id] of Object.entries(FIELD_IDS)) d[f] = $(id).value;
    for (const k of ['green', 'red', 'none']) d.labels[k] = $(`lbl-${k}`).value;
  }
  function loadFields(l) { // het concept van taal l in de velden
    cfg.shown = l;
    const d = cfg.drafts[l], base = cfg.drafts.nl;
    for (const [f, id] of Object.entries(FIELD_IDS)) {
      const el = $(id);
      el.value = d[f];
      if (el.dataset.ph === undefined) el.dataset.ph = el.getAttribute('placeholder') || '';
      // een andere taal toont de Nederlandse tekst als hint: leeg = die tekst
      const fallback = l !== 'nl' && !WITH_DEFAULT.has(f) ? base[f] : '';
      el.setAttribute('placeholder', fallback ? I18n.t('Nederlands: {tekst}', { tekst: fallback.slice(0, 80) }) : el.dataset.ph);
    }
    for (const k of ['green', 'red', 'none']) {
      const el = $(`lbl-${k}`);
      if (el.dataset.ph === undefined) el.dataset.ph = el.getAttribute('placeholder') || '';
      el.value = d.labels[k];
      el.setAttribute('placeholder', l !== 'nl' && base.labels[k] ? base.labels[k] : el.dataset.ph);
    }
    renderOrg();
    document.querySelectorAll('#cfg-langbar button').forEach((b) => b.setAttribute('aria-selected', b.dataset.lang === l));
    document.querySelectorAll('.lang-chip').forEach((c) => c.replaceChildren(I18n.flag(l)));
  }
  function buildLangBar() {
    const bar = $('cfg-langbar');
    bar.classList.toggle('hidden', !I18n.multi);
    bar.replaceChildren(...I18n.LANGS.map((x) => {
      const b = document.createElement('button');
      b.type = 'button'; b.setAttribute('role', 'tab'); b.dataset.lang = x.code;
      b.append(I18n.flag(x.code), Object.assign(document.createElement('span'), { textContent: x.name }));
      b.onclick = () => { if (x.code === cfg.shown) return; storeFields(); cfg.lang = x.code; loadFields(x.code); };
      return b;
    }));
    // vlag-chipje bij elk veld dat per taal verschilt (alleen met meertalig)
    document.querySelectorAll('#settings [data-perlang]').forEach((f) => {
      let c = f.querySelector('.lang-chip');
      if (!c) { c = document.createElement('span'); c.className = 'lang-chip'; f.querySelector('label').append(c); }
      c.hidden = !I18n.multi;
    });
  }
  async function fillOrg() {
    $('org-err').textContent = '';
    try {
      const st = await api('/api/admin/settings');
      cfg.st = st;
      $('org-simple').checked = st.simpleUi;
      $('org-locate').checked = st.locateEnabled;
      $('org-community').checked = st.communityEnabled;
      $('org-community-looks').checked = st.communityLooks;
      $('stats-public').checked = st.statsPublic;
      statsShow = st.statsShow; for (const k of ['green', 'red', 'none']) $(`stats-${k}`).checked = statsShow[k];
      $('org-multi').checked = st.multilingual;
      $('org-passkey').value = st.passkeyName || '';
      langPicker.setValue(st.defaultLang);
      const def = { shareText: st.defaultShareTexts, community: st.defaultCommunity };
      const nl = draftFrom({ siteTitle: org.siteTitle, appName: org.appName, appShortName: org.appShortName, intro: org.intro, residentInfo: st.residentInfo, qrShareText: st.qrShareText, communityTitle: st.communityTitle, communityText: st.communityText, labels: customLabels(org.labels) }, 'nl', def);
      cfg.drafts = { nl };
      for (const [l, t] of Object.entries(st.translations || {})) cfg.drafts[l] = draftFrom(t, l, def);
      buildLangBar();
      if (!cfg.drafts[cfg.lang]) cfg.lang = I18n.defaultLang;
      loadFields(cfgLang());
    } catch (e) { $('org-err').textContent = e.message; }
  }
  // namen die van de standaardnaam afwijken (een gelijke naam is niet "eigen" en blijft leeg)
  const customLabels = (labels) => Object.fromEntries(['green', 'red', 'none'].map((k) => [k, labels && labels[k] !== DEFAULT_LABELS[k] ? labels[k] : '']));
  $('org-community-default').onclick = () => { const d = cfg.st.defaultCommunity[cfg.shown]; $('org-ctitle').value = d.title; $('org-ctext').value = d.text; };
  $('org-share-default').onclick = () => { $('org-share').value = cfg.st.defaultShareTexts[cfg.shown]; };
  $('qr-share-goto').onclick = () => { openTab('org'); setTimeout(() => { $('org-share').scrollIntoView({ block: 'center' }); $('org-share').focus(); }, 150); };
  $('org-intro').oninput = renderOrg;
  $('org-simple').onchange = async () => {
    try { await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ simpleUi: $('org-simple').checked }), expectAuth: true }); toast($('org-simple').checked ? 'Eenvoudige weergave staat aan' : 'Eenvoudige weergave staat uit'); }
    catch (e) { $('org-err').textContent = e.message; $('org-simple').checked = !$('org-simple').checked; }
  };
  $('org-community').onchange = async () => {
    try {
      await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ communityEnabled: $('org-community').checked }), expectAuth: true });
      toast($('org-community').checked ? 'Community staat aan' : 'Community staat uit, alle posities zijn gewist');
      pollCommunity();
    } catch (e) { $('org-err').textContent = e.message; $('org-community').checked = !$('org-community').checked; }
  };
  $('org-community-looks').onchange = async () => {
    try {
      await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ communityLooks: $('org-community-looks').checked }), expectAuth: true });
      toast($('org-community-looks').checked ? 'Kiezen van kleur en symbool staat aan' : 'Kiezen van kleur en symbool staat uit');
      pollCommunity();
    } catch (e) { $('org-err').textContent = e.message; $('org-community-looks').checked = !$('org-community-looks').checked; }
  };
  $('org-locate').onchange = async () => {
    try { await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ locateEnabled: $('org-locate').checked }), expectAuth: true }); toast($('org-locate').checked ? 'Knop Mijn locatie staat aan op de voorpagina' : 'Knop Mijn locatie staat uit op de voorpagina'); }
    catch (e) { $('org-err').textContent = e.message; $('org-locate').checked = !$('org-locate').checked; }
  };
  $('stats-public').onchange = async () => {
    try { await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ statsPublic: $('stats-public').checked }), expectAuth: true }); toast($('stats-public').checked ? 'Overzichtskaart staat aan op de voorpagina' : 'Overzichtskaart staat uit op de voorpagina'); }
    catch (e) { $('org-err').textContent = e.message; $('stats-public').checked = !$('stats-public').checked; }
  };
  for (const k of ['green', 'red', 'none']) {
    $(`stats-${k}`).onchange = async () => {
      const box = $(`stats-${k}`);
      try {
        const res = await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ statsShow: { [k]: box.checked } }), expectAuth: true });
        statsShow = res.statsShow; if (cfg.st) cfg.st.statsShow = statsShow;
        if (map) renderStats();
      } catch (e) { $('org-err').textContent = e.message; box.checked = !box.checked; }
    };
  }
  $('org-upload').onclick = () => $('org-file').click();
  $('org-file').onchange = async () => {
    const f = $('org-file').files[0];
    $('org-file').value = '';
    if (!f) return;
    $('org-err').textContent = '';
    try {
      const res = await api('/api/admin/logo', { method: 'POST', body: f, headers: { 'Content-Type': 'application/octet-stream' }, expectAuth: true });
      org.logo = res.logo;
      renderOrg();
      toast('Logo geüpload ✔');
    } catch (e) { $('org-err').textContent = e.message; }
  };
  $('org-remove').onclick = async () => {
    if (!confirmT('Logo verwijderen?')) return;
    try { await api('/api/admin/logo', { method: 'DELETE', expectAuth: true }); org.logo = null; renderOrg(); }
    catch (e) { $('org-err').textContent = e.message; }
  };
  $('org-upload-small').onclick = () => $('org-file-small').click();
  $('org-file-small').onchange = async () => {
    const f = $('org-file-small').files[0];
    $('org-file-small').value = '';
    if (!f) return;
    $('org-err').textContent = '';
    try {
      const res = await api('/api/admin/logo-small', { method: 'POST', body: f, headers: { 'Content-Type': 'application/octet-stream' }, expectAuth: true });
      org.logoSmall = res.logoSmall;
      renderOrg();
      toast('Klein logo geüpload ✔');
    } catch (e) { $('org-err').textContent = e.message; }
  };
  $('org-remove-small').onclick = async () => {
    if (!confirmT('Klein logo verwijderen?')) return;
    try { await api('/api/admin/logo-small', { method: 'DELETE', expectAuth: true }); org.logoSmall = null; renderOrg(); }
    catch (e) { $('org-err').textContent = e.message; }
  };
  $('org-upload-favicon').onclick = () => $('org-file-favicon').click();
  $('org-file-favicon').onchange = async () => {
    const f = $('org-file-favicon').files[0];
    $('org-file-favicon').value = '';
    if (!f) return;
    $('org-err').textContent = '';
    try {
      const res = await api('/api/admin/favicon', { method: 'POST', body: f, headers: { 'Content-Type': 'application/octet-stream' }, expectAuth: true });
      org.favicon = res.favicon;
      renderOrg();
      toast('Favicon geüpload ✔');
    } catch (e) { $('org-err').textContent = e.message; }
  };
  $('org-remove-favicon').onclick = async () => {
    if (!confirmT('Favicon verwijderen?')) return;
    try { await api('/api/admin/favicon', { method: 'DELETE', expectAuth: true }); org.favicon = null; renderOrg(); }
    catch (e) { $('org-err').textContent = e.message; }
  };
  $('org-save').onclick = async () => {
    $('org-err').textContent = '';
    try {
      storeFields();
      const same = (a, b) => a.trim().replace(/\r\n?/g, '\n') === b;
      const norm = (l, d) => ({
        ...d,
        qrShareText: same(d.qrShareText, cfg.st.defaultShareTexts[l]) ? '' : d.qrShareText,
        communityTitle: same(d.communityTitle, cfg.st.defaultCommunity[l].title) ? '' : d.communityTitle,
        communityText: same(d.communityText, cfg.st.defaultCommunity[l].text) ? '' : d.communityText,
      }); // gelijk aan de standaardtekst = leeg
      const nl = norm('nl', cfg.drafts.nl);
      const translations = Object.fromEntries(Object.entries(cfg.drafts).filter(([l]) => l !== 'nl').map(([l, d]) => [l, norm(l, d)]));
      const res = await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ ...nl, translations, passkeyName: $('org-passkey').value }), expectAuth: true });
      api('/api/auth/status').then((s) => signalPasskeyName(s.passkeyDetails)).catch(() => {}); // de nieuwe naam ook in de wachtwoordbeheerder
      const data = I18n.localize(await api('/api/map'));
      Wijk.setLabels(data.labels); org.labels = res.labels;
      if (typeof render === 'function' && map) { render(); renderChangesIfOpen(); }
      org.intro = res.intro; org.siteTitle = res.siteTitle; org.appName = res.appName; org.appShortName = res.appShortName;
      toast('Opgeslagen ✔');
    } catch (e) { $('org-err').textContent = e.message; }
  };

  // ---------- instellingen (uitschuifbaar menu) ----------
  const drawer = () => $('settings');
  const drawerOpen = () => drawer().classList.contains('open');
  const fmtDate = (iso) => new Date(iso).toLocaleString(I18n.locale, { dateStyle: 'medium', timeStyle: 'medium' });

  function openTab(name) {
    document.querySelectorAll('#settings [data-tab]').forEach((b) => {
      const on = b.dataset.tab === name;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on);
    });
    document.querySelectorAll('#settings [data-panel]').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== name));
    const strip = document.querySelector('#settings .tabs'), cur = strip.querySelector('.active'); // de balk scrolt als de tabs niet passen: de actieve in beeld
    if (cur) strip.scrollLeft = Math.max(0, cur.offsetLeft - (strip.clientWidth - cur.offsetWidth) / 2);
    if (name === 'security') { $('pk-err').textContent = ''; renderSecurity().catch((e) => ($('pk-err').textContent = e.message)); }
    if (name === 'users') renderUsers();
    if (name === 'backups') renderBackups();
    if (name === 'audit') renderAudit();
    if (name === 'editions') renderEditions();
    if (name === 'changes') renderChanges();
    if (name === 'residents') { renderChanges(); renderPush(); fillQrStreets(); }
    if (name === 'org') fillOrg();
  }
  let versionShown = false;
  async function showVersion() {
    if (versionShown) return;
    try {
      const info = await api('/api/admin/info');
      $('app-version').textContent = info.label;
      $('app-version').title = `Build (commit): ${info.buildFull}`;
      versionShown = true;
    } catch { $('app-version').textContent = 'onbekend'; }
  }

  function openSettings(tab) {
    showVersion();
    drawer().classList.add('open');
    drawer().setAttribute('aria-hidden', 'false');
    $('scrim').classList.add('show');
    openTab(tab || document.querySelector('#settings [data-tab].active')?.dataset.tab || 'security');
    $('settings-close').focus();
  }
  function closeSettings() {
    drawer().classList.remove('open');
    drawer().setAttribute('aria-hidden', 'true');
    $('scrim').classList.remove('show');
    $('settings-open').focus();
  }
  $('settings-open').onclick = () => (drawerOpen() ? closeSettings() : openSettings(pendingCount + messageCount > 0 ? 'changes' : undefined));
  $('settings-close').onclick = closeSettings;
  $('scrim').onclick = closeSettings;
  document.querySelectorAll('#settings [data-tab]').forEach((b) => (b.onclick = () => openTab(b.dataset.tab)));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drawerOpen() && !document.querySelector('dialog[open]')) closeSettings();
  });

  // ---------- auditlog ----------
  // Alleen lezen: de server geeft de regels van de log, nieuwste eerst, per pagina met een verwijzing naar de oudere. De
  // samenvatting is door de server in het Nederlands vastgelegd op het moment van de wijziging en wordt niet vertaald.
  const AUDIT_PAGE = 50;
  let auditNext = null; // verwijzing naar de volgende (oudere) pagina, of null als er geen is
  let auditToken = 0; // een oudere, tragere aanvraag mag een nieuwere niet overschrijven
  async function renderAudit(more = false) {
    $('audit-err').textContent = '';
    const token = ++auditToken;
    const params = new URLSearchParams({ limit: String(AUDIT_PAGE) });
    if ($('audit-cat').value) params.set('category', $('audit-cat').value);
    const q = $('audit-q').value.trim();
    if (q) params.set('q', q);
    if (more && auditNext !== null) params.set('before', String(auditNext));
    let res;
    try { res = await api(`/api/admin/audit?${params}`); }
    catch (e) { if (token === auditToken) $('audit-err').textContent = e.message; return; }
    if (token !== auditToken) return;
    const box = $('audit-list');
    if (!more) box.replaceChildren();
    for (const e of res.items) {
      const row = document.createElement('div');
      row.className = 'bk-row audit-row';
      const info = document.createElement('div');
      info.className = 'bk-info';
      const what = document.createElement('div');
      what.className = 'audit-sum';
      what.setAttribute('data-i18n-skip', '');
      what.textContent = e.summary || e.action;
      const when = document.createElement('span');
      when.textContent = fmtDate(e.at);
      info.append(what, when);
      row.append(info);
      box.append(row);
    }
    if (!box.children.length) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = $('audit-q').value.trim() || $('audit-cat').value ? 'Geen wijzigingen gevonden.' : 'Er zijn nog geen wijzigingen vastgelegd.';
      box.append(p);
    }
    auditNext = res.next;
    $('audit-more').hidden = auditNext === null;
  }
  let auditTimer = null;
  $('audit-cat').onchange = () => renderAudit();
  $('audit-q').oninput = () => { clearTimeout(auditTimer); auditTimer = setTimeout(() => renderAudit(), 300); };
  $('audit-more').onclick = () => renderAudit(true);

  // ---------- backups ----------
  const selectedBackups = () => [...document.querySelectorAll('#bk-list input[type=checkbox]:checked')].map((c) => c.value);
  const syncBackupButtons = () => { $('bk-delete').disabled = selectedBackups().length === 0; };

  // Welke edities in een backup zitten: aantal en namen (de namen worden niet vertaald).
  function backupEditions(list) {
    const span = document.createElement('span');
    span.className = 'bk-editions';
    span.setAttribute('data-i18n-skip', '');
    const names = list.map((e) => e.label);
    const shown = names.length > 4 ? `${names.slice(0, 4).join(', ')} +${names.length - 4}` : names.join(', ');
    span.textContent = !list.length ? I18n.tr('Geen edities')
      : list.length === 1 ? tName('Editie: {naam}', {}, shown) : tName('{n} edities: {naam}', { n: list.length }, shown);
    if (names.length > 4) span.title = names.join(', ');
    return span;
  }

  async function renderBackups() {
    $('bk-err').textContent = '';
    let list;
    try { list = await api('/api/admin/backups'); } catch (e) { $('bk-err').textContent = e.message; return; }
    const box = $('bk-list');
    box.replaceChildren();
    if (!list.length) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = 'Er zijn nog geen backups. Na de eerstvolgende keer opslaan verschijnt hier de eerste.';
      box.append(p);
    }
    for (const b of list) {
      const row = document.createElement('div');
      row.className = 'bk-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.value = b.id; cb.setAttribute('aria-label', `Selecteer backup van ${fmtDate(b.createdAt)}`);
      cb.onchange = syncBackupButtons;
      const info = document.createElement('div');
      info.className = 'bk-info';
      const t = document.createElement('strong'); t.textContent = b.title || fmtDate(b.createdAt);
      const d = document.createElement('span');
      const parts = [`${b.reason}${b.ok ? '' : ' (mislukt)'}`, `${b.houses} huizen`];
      if (b.textLength) parts.push(`uitleg ${b.textLength} tekens`);
      if (b.settings) parts.push('instellingen'); // backups van vóór de ZIP hebben geen instellingen, logo's en apparaten
      if (b.logos) parts.push(b.logos === 1 ? '1 logo' : `${b.logos} logo's`);
      if (b.devices) parts.push(b.devices === 1 ? '1 apparaat' : `${b.devices} apparaten`);
      if (b.blocked) parts.push(`${b.blocked} geblokkeerd`);
      d.textContent = `${b.title ? `${fmtDate(b.createdAt)} · ` : ''}${parts.join(' · ')}`;
      info.append(t, d);
      if (Array.isArray(b.editions)) info.append(backupEditions(b.editions)); // backups van vóór de edities: niets tonen
      const restore = document.createElement('button');
      restore.textContent = 'Terugzetten';
      restore.onclick = () => restoreBackup(b);
      const dl = document.createElement('a');
      dl.className = 'btn'; dl.append(MDI.svg('download')); dl.title = 'Downloaden'; dl.href = `/api/admin/backups/${b.id}`; dl.download = `sint_maarten-backup-${b.id}.zip`;
      const ed = document.createElement('button');
      ed.append(MDI.svg('pencil')); ed.title = 'Titel wijzigen'; ed.setAttribute('aria-label', 'Titel wijzigen');
      ed.onclick = async () => {
        const v = promptT('Korte titel voor deze backup (leeg = geen titel):', b.title || '');
        if (v === null) return;
        try { await api(`/api/admin/backups/${b.id}/title`, { method: 'PUT', body: JSON.stringify({ title: v }), expectAuth: true }); renderBackups(); }
        catch (e) { $('bk-err').textContent = e.message; }
      };
      row.append(cb, info, ed, restore, dl);
      box.append(row);
    }
    syncBackupButtons();
  }

  $('bk-make').onclick = async () => {
    $('bk-err').textContent = '';
    try { await post('/api/admin/backups', { title: $('bk-title').value }, { expectAuth: true }); $('bk-title').value = ''; toast('Backup gemaakt ✔'); renderBackups(); }
    catch (e) { $('bk-err').textContent = e.message; }
  };

  $('bk-upload').onclick = () => $('bk-file').click();
  $('bk-file').onchange = async () => {
    const f = $('bk-file').files[0];
    $('bk-file').value = '';
    if (!f) return;
    $('bk-err').textContent = '';
    try {
      if (f.size > 25 * 1024 * 1024) throw new Error('Het bestand is te groot (maximaal 25 MB)');
      // het bestand gaat zoals het is naar de server (.zip, of .json van een oudere versie); die controleert alles
      await api('/api/admin/backups/import', { method: 'POST', body: f, headers: { 'Content-Type': 'application/octet-stream' }, expectAuth: true });
      toast('Backup geüpload ✔ Kies nu Terugzetten');
      renderBackups();
    } catch (e) { $('bk-err').textContent = e.message; }
  };

  async function restoreBackup(b) {
    // per regel vertaald: welke regels er staan, hangt af van wat de backup bevat
    const lines = [`Backup van ${fmtDate(b.createdAt)} terugzetten?`, 'De huidige staat wordt eerst zelf als backup bewaard.'];
    if (Array.isArray(b.editions)) lines.push('De edities worden ook teruggezet naar de stand van deze backup.');
    if (b.settings) lines.push("Ook de app-instellingen, de logo's en de apparaten van bewoners worden teruggezet.");
    if (dirty) lines.push('', 'Let op: niet-opgeslagen wijzigingen gaan verloren.');
    if (!confirm(lines.map((l) => I18n.tr(l)).join('\n'))) return;
    try {
      if (editing) leaveEditing(); // ook een editie in bewerking kan door het terugzetten veranderen
      await post(`/api/admin/backups/${b.id}/restore`, {}, { expectAuth: true });
      editionHouses.clear();
      await reloadFromServer();
      await loadEditions();
      toast('Backup teruggezet ✔');
      renderBackups();
    } catch (e) { $('bk-err').textContent = e.message; }
  }

  $('bk-delete').onclick = async () => {
    const ids = selectedBackups();
    if (!ids.length) return;
    if (!confirmT(`${ids.length} backup(s) definitief verwijderen? Je moet dit bevestigen met je ${confirmWord()}.`)) return;
    $('bk-err').textContent = '';
    try {
      const proof = await confirmStep();
      const res = await post('/api/admin/backups/delete', { ids, ...proof });
      toast(`${res.deleted} backup(s) verwijderd`);
      renderBackups();
    } catch (e) { $('bk-err').textContent = friendly(e); }
  };

  // ---------- wijzigingen van bewoners en meldingen ----------
  let pendingCount = 0;
  const STATUS_NL = new Proxy({}, { get: (_, k) => (Wijk.STATUS[k] ? Wijk.STATUS[k].name.toLowerCase() : k) }); // volgt de instelbare namen
  const renderChangesIfOpen = () => { if (drawerOpen() && ['changes', 'residents'].includes(activeTab())) renderChanges(); };
  const ago = (iso) => {
    const m = Math.max(0, Math.round((Date.now() - new Date(iso)) / 60000));
    return m < 1 ? 'zojuist' : m < 60 ? `${m} min geleden` : m < 1440 ? `${Math.round(m / 60)} uur geleden` : `${Math.round(m / 1440)} dagen geleden`;
  };
  const activeTab = () => document.querySelector('#settings [data-tab].active')?.dataset.tab;

  // Badges: teller op tab en tandwiel, in de paginatitel en (in de geïnstalleerde app) op het app-icoon.
  let messageCount = 0;
  function setBadge(n) {
    for (const id of ['tab-badge', 'cog-badge', 'nav-badge']) { $(id).hidden = n === 0; $(id).textContent = n; }
    $('pend-badge').hidden = pendingCount === 0; $('pend-badge').textContent = pendingCount;
    $('msg-badge').hidden = messageCount === 0; $('msg-badge').textContent = messageCount;
    document.title = Wijk.docTitle(n ? `(${n}) Beheer` : 'Beheer');
    try { if (navigator.setAppBadge) { if (n > 0) navigator.setAppBadge(n).catch(() => {}); else navigator.clearAppBadge().catch(() => {}); } } catch { /* niet ondersteund */ }
  }

  async function pollChanges(first) {
    try {
      const { pending, messages } = await api('/api/admin/changes/count');
      if (!first && pending > pendingCount) toast(`${pending} wijziging${pending === 1 ? '' : 'en'} wacht${pending === 1 ? '' : 'en'} op goedkeuring`);
      if (!first && messages > messageCount) toast('Nieuw bericht van een bewoner');
      const changed = pending !== pendingCount || messages !== messageCount;
      pendingCount = pending; messageCount = messages;
      setBadge(pending + messages);
      if (changed && drawerOpen() && ['changes', 'residents'].includes(activeTab())) renderChanges();
    } catch { /* offline of uitgelogd: volgende poging */ }
  }

  // Een goedgekeurde wijziging ook in de lokale lijst verwerken, zodat een volgende "Opslaan" hem niet overschrijft.
  function applyChange(c) {
    const h = c && liveList().find((x) => x.id === c.houseId); // altijd de live kaart, ook als je een editie bewerkt
    if (h) { h.status = c.status; touchHouses(); render(); }
  }

  let shareTexts = {}; // tekst bij delen via WhatsApp per taal (instelling in Config → Teksten)
  async function renderChanges() {
    $('chg-err').textContent = '';
    let data;
    try { data = await api('/api/admin/changes'); } catch (e) { $('chg-err').textContent = e.message; return; }
    $('res-enabled').checked = data.enabled;
    $('res-apponly').checked = !!data.appOnly;
    const sched = data.schedule || {};
    $('res-sched').checked = !!sched.on;
    if (sched.until && document.activeElement !== $('res-until')) $('res-until').value = toLocalInput(sched.until);
    $('res-until').disabled = false;
    const cd = data.code || {};
    $('res-qr-only').checked = !!data.qrOnly;
    shareTexts = data.shareTexts || shareTexts;
    $('res-code-on').checked = !!cd.on;
    if (document.activeElement !== $('res-code')) $('res-code').value = cd.code || '';
    const gf = data.geofence || {};
    $('res-geo').checked = !!gf.on;
    if (document.activeElement !== $('res-geo-radius')) $('res-geo-radius').value = gf.radius || 500;
    $('res-geo-radius').disabled = !gf.on;
    $('res-swap').checked = !!sched.swap;
    $('res-swap').disabled = !sched.on;
    $('res-enabled').disabled = !!sched.on;
    $('res-apponly').disabled = !!sched.on || !data.enabled;
    pendingCount = data.pending.length; messageCount = (data.messages || []).length; setBadge(pendingCount + messageCount);
    const ml = $('msg-list');
    ml.replaceChildren();
    if (!messageCount) { const p = document.createElement('p'); p.className = 'muted'; p.style.padding = '8px 10px'; p.textContent = 'Geen berichten.'; ml.append(p); }
    for (const m of data.messages || []) {
      const row = document.createElement('div'); row.className = 'chg-row';
      const info = document.createElement('div'); info.className = 'chg-info';
      const t = document.createElement('strong'); t.textContent = m.text;
      const d = document.createElement('span');
      d.textContent = [m.ownTitle ? `Apparaat van ${m.ownTitle}` : 'Apparaat zonder huis', m.scannedTitle ? `scande de QR van ${m.scannedTitle}` : null, ago(m.createdAt)].filter(Boolean).join(' · ');
      info.append(t, d);
      const del = document.createElement('button'); del.textContent = 'Afgehandeld';
      del.onclick = async () => { try { await api(`/api/admin/messages/${m.id}`, { method: 'DELETE', expectAuth: true }); renderChanges(); } catch (e) { $('chg-err').textContent = e.message; } };
      row.append(info, del);
      ml.append(row);
    }
    const box = $('pend-list');
    box.replaceChildren();
    if (!data.pending.length) {
      const p = document.createElement('p'); p.className = 'muted'; p.style.padding = '8px 10px'; p.textContent = 'Geen wijzigingen die op goedkeuring wachten.'; box.append(p);
    }
    for (const c of data.pending) {
      const row = document.createElement('div'); row.className = 'chg-row';
      const info = document.createElement('div'); info.className = 'chg-info';
      const t = document.createElement('strong'); t.textContent = c.title;
      const d = document.createElement('span'); d.textContent = `${STATUS_NL[c.from]} → ${STATUS_NL[c.to]} · ${ago(c.updatedAt)}`;
      info.append(t, d);
      const ok = document.createElement('button'); ok.className = 'primary'; ok.textContent = 'Goedkeuren';
      const no = document.createElement('button'); no.textContent = 'Afwijzen';
      ok.onclick = () => decideChange(c.id, 'approve');
      no.onclick = () => decideChange(c.id, 'reject');
      const bl = document.createElement('button'); bl.className = 'danger'; bl.textContent = 'Blokkeren';
      bl.onclick = () => blockDevice(c.rid, c.title);
      row.append(info, ok, no, bl);
      box.append(row);
    }
    $('pend-all').disabled = !data.pending.length;

    const rl = $('res-list');
    rl.replaceChildren();
    if (!data.residents.length) { const p = document.createElement('p'); p.className = 'muted'; p.style.padding = '8px 10px'; p.textContent = 'Nog geen apparaten aangemeld.'; rl.append(p); }
    for (const r of data.residents) {
      const row = document.createElement('div'); row.className = 'chg-row';
      const info = document.createElement('div'); info.className = 'chg-info';
      const t = document.createElement('strong'); t.textContent = r.title;
      const d = document.createElement('span'); d.textContent = `aangemeld ${ago(r.createdAt)} · laatst actief ${ago(r.lastActivity)}${r.ip ? ` · ${r.ip}` : ''}`;
      info.append(t, d);
      const del = document.createElement('button'); del.className = 'danger'; del.textContent = 'Verwijderen';
      del.onclick = async () => {
        if (!confirmT(`De koppeling met ${r.title} verwijderen? Dat apparaat kan dan opnieuw een huis kiezen.`)) return;
        try { await api(`/api/admin/residents/${r.rid}`, { method: 'DELETE', expectAuth: true }); renderChanges(); }
        catch (e) { $('chg-err').textContent = e.message; }
      };
      const bl = document.createElement('button'); bl.className = 'danger'; bl.textContent = 'Blokkeren';
      bl.onclick = () => blockDevice(r.rid, r.title, r.ip);
      row.append(info, bl, del);
      rl.append(row);
    }

    const bk = $('blk-list');
    bk.replaceChildren();
    if (!data.blocked.length) { const p = document.createElement('p'); p.className = 'muted'; p.style.padding = '8px 10px'; p.textContent = 'Geen geblokkeerde apparaten.'; bk.append(p); }
    for (const b of data.blocked) {
      const row = document.createElement('div'); row.className = 'chg-row';
      const info = document.createElement('div'); info.className = 'chg-info';
      const t = document.createElement('strong'); t.textContent = b.title;
      const d = document.createElement('span'); d.textContent = `geblokkeerd ${ago(b.at)}${b.ip ? ` · ook IP ${b.ip}` : ' · alleen dit apparaat'}`;
      info.append(t, d);
      const un = document.createElement('button'); un.textContent = 'Deblokkeren';
      un.onclick = async () => {
        try { await api(`/api/admin/blocks/${b.id}`, { method: 'DELETE', expectAuth: true }); toast('Gedeblokkeerd'); renderChanges(); }
        catch (e) { $('chg-err').textContent = e.message; }
      };
      row.append(info, un);
      bk.append(row);
    }
  }

  // datum/tijd: <input type="datetime-local"> werkt in lokale tijd; de server bewaart UTC
  const pad = (n) => String(n).padStart(2, '0');
  function toLocalInput(iso) {
    const d = new Date(iso);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  async function saveSchedule(on) {
    $('chg-err').textContent = '';
    const v = $('res-until').value;
    try {
      if (on && !v) throw new Error('Kies eerst een datum en tijd');
      await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ residentsOff: on, residentsUntil: v ? new Date(v).toISOString() : null }), expectAuth: true });
      toast(on ? 'Wijzigen wordt automatisch uitgeschakeld' : 'Planning uitgezet');
    } catch (e) { msg = e.message; $('res-sched').checked = !on; }
    await renderChanges();
    if (msg) $('chg-err').textContent = msg;
  }
  async function saveGeo(body, undo) {
    $('chg-err').textContent = '';
    let msg = '';
    try {
      await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(body), expectAuth: true });
      if ('residentsGeofence' in body) toast(body.residentsGeofence ? 'Wijzigen kan alleen nog in de wijk' : 'Locatiecontrole staat uit');
    } catch (e) { msg = e.message; undo?.(); }
    await renderChanges();
    if (msg) $('chg-err').textContent = msg;
  }
  $('res-geo').onchange = () => saveGeo({ residentsGeofence: $('res-geo').checked, residentsGeofenceRadius: Number($('res-geo-radius').value) || 500 }, () => { $('res-geo').checked = !$('res-geo').checked; });
  $('res-geo-radius').onchange = () => saveGeo({ residentsGeofenceRadius: Number($('res-geo-radius').value) });
  async function saveCode(body, undo) {
    $('chg-err').textContent = '';
    let msg = '';
    try {
      await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(body), expectAuth: true });
      toast('residentsCodeOn' in body ? (body.residentsCodeOn ? 'Code voor apparaten zonder GPS staat aan' : 'Code staat uit') : 'Code opgeslagen ✔');
    } catch (e) { msg = e.message; undo?.(); }
    await renderChanges();
    if (msg) $('chg-err').textContent = msg;
  }
  $('res-code-on').onchange = () => saveCode({ residentsCode: $('res-code').value.trim(), residentsCodeOn: $('res-code-on').checked }, () => { $('res-code-on').checked = !$('res-code-on').checked; });
  $('res-code-save').onclick = () => saveCode({ residentsCode: $('res-code').value.trim() });
  $('res-code-copy').onclick = async () => {
    const v = $('res-code').value.trim();
    if (!v) { toast('Er is nog geen code om te kopiëren'); return; }
    try { await navigator.clipboard.writeText(v); }
    catch { $('res-code').select(); document.execCommand('copy'); } // reserve zonder clipboard-API (bijv. http)
    toast('Code gekopieerd ✔');
  };
  $('res-code-gen').onclick = () => { $('res-code').value = String(Math.floor(1000 + Math.random() * 9000)); $('res-code').focus(); };
  // ---------- QR-codes ----------
  const siteName = async (l) => I18n.localize(await api('/api/map'), l).title || I18n.tFor(l || I18n.lang).tr('Onze wijk');
  async function fillQrStreets() {
    try {
      const items = await api('/api/admin/qr');
      const streets = [...new Set(items.map((i) => i.street).filter(Boolean))].sort(Wijk.natCompare);
      const cur = $('qr-street').value;
      $('qr-street').replaceChildren(new Option('Alle straten', ''), ...streets.map((x) => new Option(x, x)));
      $('qr-street').value = streets.includes(cur) ? cur : '';
    } catch { /* geen sessie of geen huizen */ }
  }
  $('res-qr-only').onchange = async () => {
    try { await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ residentsQrOnly: $('res-qr-only').checked }), expectAuth: true }); toast($('res-qr-only').checked ? 'Huis kiezen kan nu alleen met een QR-code' : 'Huis kiezen kan weer via de kaart'); }
    catch (e) { $('qr-err').textContent = e.message; $('res-qr-only').checked = !$('res-qr-only').checked; }
  };
  $('qr-print').onclick = async () => {
    $('qr-err').textContent = '';
    try {
      const street = $('qr-street').value;
      const items = (await api('/api/admin/qr')).filter((i) => !street || i.street === street);
      if (!items.length) { $('qr-err').textContent = 'Geen huizen om af te drukken.'; return; }
      const doc = await Wijk.buildQrPdf({ title: await siteName(I18n.defaultLang), items, logo: org.logo, lang: I18n.defaultLang }); // de brieven gaan in de standaardtaal van de site
      doc.save(`qr-codes${street ? '-' + street.toLowerCase().replace(/[^a-z0-9]+/g, '-') : ''}.pdf`);
      toast(`${items.length} QR-code(s) in de PDF ✔`);
    } catch (e) { $('qr-err').textContent = e.message; }
  };
  $('qr-rotate-all').onclick = async () => {
    if (!confirmT('Alle QR-codes vernieuwen? Alle uitgedeelde (en afgedrukte) QR-codes werken dan niet meer.')) return;
    try { await post('/api/admin/qr/rotate-all', {}, { expectAuth: true }); toast('Alle QR-codes zijn vernieuwd'); }
    catch (e) { $('qr-err').textContent = e.message; }
  };
  // ---------- huis-popup: status, QR-kaartje, link en delen ----------
  let qrItem = null, qrFile = null;
  // Taal van het kaartje en het WhatsApp-bericht: standaard de taal van de site; met meertalig kies je er een in de popup.
  let waLang = I18n.defaultLang;
  const qrLangPicker = I18n.picker({ value: waLang, label: 'Taal van het kaartje en het bericht', onSelect: (code) => { waLang = code; drawQrCard(); } });
  $('qr-lang-slot').append(qrLangPicker);
  $('qr-lang-row').classList.toggle('hidden', !I18n.multi);
  async function drawQrCard() {
    const item = qrItem;
    const url = await Wijk.qrCardDataUrl({ title: item.title, url: item.url, siteTitle: await siteName(waLang), logo: org.logo, lang: waLang });
    if (item !== qrItem) return; // intussen een ander huis geopend
    $('qr-img').src = url;
    // data-URL naar bestand (fetch op data: staat de CSP niet toe)
    const bin = atob(url.split(',')[1]), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    qrFile = new File([bytes], `qr-${item.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`, { type: 'image/png' });
    $('qr-share').classList.toggle('hidden', !(navigator.canShare && navigator.canShare({ files: [qrFile] })));
  }
  async function showQr(item, { withStatus = false } = {}) {
    qrItem = item;
    waLang = I18n.defaultLang;
    qrLangPicker.setValue(waLang);
    $('qr-title').textContent = item.title;
    $('qr-link').value = item.url;
    $('qr-status-wrap').classList.toggle('hidden', !withStatus);
    $('qr-state').textContent = item.taken ? 'Dit huis is al aan een apparaat gekoppeld. Verwijder de koppeling (Instellingen → Bewoners → Apparaten) om opnieuw te kunnen scannen.' : 'Nog aan geen enkel apparaat gekoppeld.';
    syncQrStatus();
    api('/api/admin/changes').then((d) => { shareTexts = d.shareTexts || shareTexts; }).catch(() => {}); // actuele deeltekst (Config → Teksten)
    if (!$('qr-dialog').open) $('qr-dialog').showModal(); // meteen tonen; het kaartje volgt zodra het getekend is
    await drawQrCard();
  }
  const syncQrStatus = () => {
    const h = qrItem && liveList().find((x) => x.id === qrItem.houseId);
    document.querySelectorAll('#qr-status button').forEach((b) => b.classList.toggle('active', !!h && b.dataset.st === h.status));
  };
  async function openHouseDialog(id, opts) {
    try {
      const item = (await api('/api/admin/qr')).find((i) => i.houseId === id);
      if (!item) { toast('Sla het huis eerst op; daarna is de QR-code beschikbaar.'); return; }
      await showQr(item, opts);
    } catch (e) { toast(e.message); }
  }
  $('p-qr').onclick = () => { const h = selected(); if (h) openHouseDialog(h.id, { withStatus: false }); };
  $('qr-x').onclick = () => $('qr-dialog').close();
  document.querySelectorAll('#qr-status button').forEach((b) => (b.onclick = async () => {
    if (editTarget !== LIVE) return; // de popup met QR hoort bij de live kaart
    const h = qrItem && houses.find((x) => x.id === qrItem.houseId);
    if (!h || h.status === b.dataset.st) return;
    h.status = b.dataset.st;
    syncQrStatus();
    document.querySelectorAll('#qr-status button').forEach((x) => (x.disabled = true));
    await save(); // slaat direct op (en maakt een backup)
    document.querySelectorAll('#qr-status button').forEach((x) => (x.disabled = false));
  }));
  $('qr-copy').onclick = async () => {
    try { await navigator.clipboard.writeText($('qr-link').value); } catch { $('qr-link').select(); document.execCommand('copy'); }
    toast('Link gekopieerd ✔');
  };
  // De tekst bij delen is instelbaar per taal (Config → Teksten): {adres} en {link} worden ingevuld; ontbreekt {link}, dan komt de link erachter.
  // Het bericht gaat in de standaardtaal van de site.
  const waText = () => {
    const tpl = shareTexts[waLang] || '{adres} {link}';
    const t = tpl.includes('{link}') ? tpl : `${tpl}\n{link}`;
    return t.replaceAll('{adres}', qrItem.title).replaceAll('{link}', qrItem.url);
  };
  $('qr-wa').onclick = () => window.open(`https://wa.me/?text=${encodeURIComponent(waText())}`, '_blank', 'noopener');
  $('qr-share').onclick = async () => { try { await navigator.share({ files: [qrFile], text: waText() }); } catch { /* geannuleerd */ } };
  $('qr-png').onclick = () => {
    const a = document.createElement('a');
    a.href = $('qr-img').src; a.download = qrFile ? qrFile.name : 'qr.png';
    document.body.append(a); a.click(); a.remove();
  };
  $('qr-rotate').onclick = async () => {
    if (!qrItem || !confirmT(`De QR-code van ${qrItem.title} vernieuwen? De oude code werkt dan niet meer.`)) return;
    try { await showQr(await post(`/api/admin/qr/${encodeURIComponent(qrItem.houseId)}/rotate`, {}, { expectAuth: true }), { withStatus: !$('qr-status-wrap').classList.contains('hidden') }); toast('QR-code vernieuwd'); }
    catch (e) { toast(e.message); }
  };

  // ---------- weergave (standaard) en bewerken ----------
  let editing = false;
  function setEditing(on) {
    editing = on;
    $('v-edit').classList.toggle('view-mode', !on);
    $('edit-toggle').replaceChildren(MDI.svg(on ? 'eye-outline' : 'pencil'), Object.assign(document.createElement('span'), { textContent: on ? 'Weergave' : 'Bewerken' }));
    $('edit-toggle').setAttribute('aria-pressed', String(on));
    $('nav-edit').setAttribute('aria-pressed', String(on));
    $('nav-edit').querySelector('.lbl').textContent = on ? 'Weergave' : 'Bewerken';
    $('nav-edit').querySelector('.ico').replaceChildren(MDI.svg(on ? 'eye-outline' : 'pencil'));
    if (on && map) { map.closePopup(); fillEditionSelects(); render(); }
    if (!on && typeof setMode === 'function') { setMode('select'); selectedId = null; render(); }
    setTimeout(() => map && map.invalidateSize(), 0);
  }
  $('nav-edit').onclick = () => $('edit-toggle').click();
  $('nav-cog').onclick = () => $('settings-open').click();
  // Bewerken werkt op de kaart die rechtsboven gekozen is: de live kaart of een editie (zie startEditing).
  $('edit-toggle').onclick = async () => {
    if (!editing) return startEditing();
    if (dirty && !confirmT('Er zijn niet-opgeslagen wijzigingen. Toch naar de weergave? Die wijzigingen gaan verloren.')) return;
    if (dirty && editTarget === LIVE) await reloadFromServer(); // bij een editie vervalt alleen de kopie
    leaveEditing();
  };

  $('res-swap').onchange = async () => {
    try { await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ residentsSwapAfter: $('res-swap').checked }), expectAuth: true }); toast($('res-swap').checked ? 'Na de einddatum kan nog groen ↔ rood worden gewisseld' : 'Na de einddatum is wijzigen helemaal dicht'); }
    catch (e) { $('chg-err').textContent = e.message; $('res-swap').checked = !$('res-swap').checked; }
  };
  $('res-sched').onchange = () => saveSchedule($('res-sched').checked);
  $('res-until').onchange = () => { if ($('res-sched').checked) saveSchedule(true); };

  async function blockDevice(rid, title, ip) {
    if (!confirmT(`Het apparaat van ${title} blokkeren? De koppeling en openstaande wijzigingen worden verwijderd en dit apparaat kan niet meer wijzigen.`)) return;
    let withIp = false;
    if (ip) withIp = confirmT(`Ook het IP-adres ${ip} blokkeren?\n\nLet op: bewoners achter hetzelfde netwerk (bijv. dezelfde router) delen vaak een IP-adres en worden dan ook geblokkeerd.\n\nOK = ook IP blokkeren, Annuleren = alleen dit apparaat.`);
    try { await post(`/api/admin/residents/${rid}/block`, { withIp }, { expectAuth: true }); toast('Geblokkeerd'); await renderChanges(); }
    catch (e) { $('chg-err').textContent = e.message; }
  }

  async function decideChange(id, action) {
    try {
      const res = await post(`/api/admin/changes/${id}/${action}`, {}, { expectAuth: true });
      if (action === 'approve') applyChange(res.change);
      toast(action === 'approve' ? 'Goedgekeurd ✔' : 'Afgewezen');
      await renderChanges();
    } catch (e) { $('chg-err').textContent = e.message; }
  }

  $('pend-all').onclick = async () => {
    try {
      const res = await post('/api/admin/changes/approve-all', {}, { expectAuth: true });
      res.changes.forEach(applyChange);
      toast(`${res.changes.length} wijziging(en) goedgekeurd ✔`);
      await renderChanges();
    } catch (e) { $('chg-err').textContent = e.message; }
  };

  $('res-apponly').onchange = async () => {
    try { await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ residentsAppOnly: $('res-apponly').checked }), expectAuth: true }); toast($('res-apponly').checked ? 'Wijzigen kan nu alleen in de geïnstalleerde app' : 'Wijzigen kan ook in de browser'); }
    catch (e) { $('chg-err').textContent = e.message; $('res-apponly').checked = !$('res-apponly').checked; }
  };

  $('res-enabled').onchange = async () => {
    $('res-apponly').disabled = !$('res-enabled').checked;
    try { await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ residentsEnabled: $('res-enabled').checked }), expectAuth: true }); toast($('res-enabled').checked ? 'Wijzigen door bewoners staat aan' : 'Wijzigen door bewoners staat uit'); }
    catch (e) { $('chg-err').textContent = e.message; $('res-enabled').checked = !$('res-enabled').checked; }
  };

  // ---- pushmeldingen op dit apparaat ----
  const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const b64 = (str) => { const pad = '='.repeat((4 - (str.length % 4)) % 4); const raw = atob((str + pad).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(raw, (c) => c.charCodeAt(0)); };
  const deviceLabel = () => { const ua = navigator.userAgent; return /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : 'Apparaat'; };
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

  async function currentSub() {
    if (!pushSupported) return null;
    const reg = await navigator.serviceWorker.ready;
    return reg.pushManager.getSubscription();
  }

  async function renderPush() {
    $('push-err').textContent = '';
    const on = $('push-on'), off = $('push-off'), test = $('push-test');
    [on, off, test].forEach((b) => b.classList.add('hidden'));
    if (!pushSupported) {
      $('push-status').textContent = 'Dit apparaat of deze browser ondersteunt geen pushmeldingen. Op een iPhone/iPad: zet het beheer eerst op het beginscherm (iOS 16.4 of nieuwer) en open het vandaar.';
    } else if (Notification.permission === 'denied') {
      $('push-status').textContent = 'Meldingen zijn in de browser geblokkeerd voor deze site. Sta ze toe in de site-instellingen en probeer opnieuw.';
    } else {
      const sub = await currentSub();
      $('push-status').textContent = sub ? 'Meldingen staan aan op dit apparaat: je krijgt een melding bij een nieuwe wijziging.' : 'Meldingen staan uit op dit apparaat.';
      (sub ? off : on).classList.remove('hidden');
      if (sub) test.classList.remove('hidden');
    }
    const box = $('push-devices');
    try {
      const devices = await api('/api/admin/push/devices');
      box.classList.toggle('hidden', !devices.length);
      box.replaceChildren(...devices.map((d) => {
        const row = document.createElement('div'); row.className = 'chg-row';
        const info = document.createElement('div'); info.className = 'chg-info';
        const t = document.createElement('strong'); t.textContent = d.label;
        const s = document.createElement('span'); s.textContent = `ingesteld ${ago(d.createdAt)}`;
        info.append(t, s);
        const del = document.createElement('button'); del.className = 'danger'; del.textContent = 'Verwijderen';
        del.onclick = async () => { try { await api(`/api/admin/push/devices/${d.id}`, { method: 'DELETE', expectAuth: true }); renderPush(); } catch (e) { $('push-err').textContent = e.message; } };
        row.append(info, del);
        return row;
      }));
    } catch { box.classList.add('hidden'); }
  }

  $('push-on').onclick = async () => {
    $('push-err').textContent = '';
    try {
      if (await Notification.requestPermission() !== 'granted') throw new Error('Toestemming voor meldingen is niet gegeven.');
      const { publicKey } = await api('/api/admin/push/key');
      const reg = await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(publicKey) });
      const { id } = await post('/api/admin/push/subscribe', { subscription: sub.toJSON(), label: deviceLabel() });
      try { localStorage.setItem('sm-push-id', id); } catch {}
      toast('Meldingen aangezet ✔');
    } catch (e) { $('push-err').textContent = friendly(e); }
    renderPush();
  };
  $('push-off').onclick = async () => {
    try {
      const sub = await currentSub();
      let id = null; try { id = localStorage.getItem('sm-push-id'); } catch {}
      if (id) await api(`/api/admin/push/devices/${id}`, { method: 'DELETE', expectAuth: true });
      if (sub) await sub.unsubscribe();
      toast('Meldingen uitgezet');
    } catch (e) { $('push-err').textContent = e.message; }
    renderPush();
  };
  $('push-test').onclick = async () => {
    try { const r = await post('/api/admin/push/test', {}); toast(r.sent ? 'Testmelding verstuurd' : 'Geen apparaat bereikt'); }
    catch (e) { $('push-err').textContent = e.message; }
  };

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'open-tab') { openSettings('changes'); pollChanges(true); }
    });
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pollChanges(); });

  // ---------- editor ----------
  let map, houses = [], layers = new Map(); // id -> L.polygon
  let selectedId = null, mode = 'select', newStatus = 'none', draft = [], dirty = false;
  let handles = [], draftLayer = null;
  const uid = () => Math.random().toString(36).slice(2, 10);

  function setDirty(v = true) {
    dirty = v;
    touchHouses();
    $('dirty').textContent = v ? '● Niet opgeslagen' : '';
  }
  window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

  const selected = () => houses.find((h) => h.id === selectedId);
  const nameOf = (h, i) => (h.street || h.number ? Wijk.houseTitle(h) : `Huis ${i + 1}`);
  let filterStreet = ''; // '' = alle straten, '\u0000none' = huizen zonder straat
  const NO_STREET = '\u0000none';
  const inFilter = (h) => !filterStreet || (filterStreet === NO_STREET ? !h.street : h.street === filterStreet);
  let nums = null, numsRev = 0, numsBuilt = '';
  let liveGroup = null; // de huizen van de live kaart (verborgen zolang een editie of vergelijking op de kaart staat)
  const touchHouses = () => { numsRev++; };

  function hint() {
    $('hint').textContent = mode === 'draw'
      ? (draft.length
        ? `${draft.length} punt(en). Klik de hoekpunten van het huis; sluit af door op het gele beginpunt te klikken, dubbel te klikken of Enter te drukken. Backspace = laatste punt weg, Esc = annuleren.`
        : 'Zoom ver in en klik op de hoeken van een huis om er een vlak overheen te leggen. Slepen verplaatst de kaart.')
      : 'Klik op een huis om het te selecteren. Sleep de witte punten om de vorm aan te passen. Sneltoetsen: G = ' + Wijk.STATUS.green.name.toLowerCase() + ', R = ' + Wijk.STATUS.red.name.toLowerCase() + ', Delete = verwijderen.';
  }

  function syncPolygons() {
    for (const [id, l] of layers) if (!houses.find((h) => h.id === id)) { liveGroup.removeLayer(l); layers.delete(id); }
    for (const h of houses) {
      let l = layers.get(h.id);
      if (!l) {
        l = L.polygon(h.points, {}).addTo(liveGroup);
        l.on('click', (e) => {
          if (!editing || mode !== 'select') return;
          L.DomEvent.stopPropagation(e);
          select(h.id);
        });
        // dubbelklik (muis): selecteermodus aan en dit huis selecteren (tijdens het tekenen alleen als er nog geen vlak loopt)
        l.on('dblclick', (e) => {
          if (mode === 'draw' && draft.length >= 3) return;
          L.DomEvent.stopPropagation(e);
          houseAction(h.id);
        });
        layers.set(h.id, l);
      }
      l.setStyle(Wijk.houseStyle(h.status, h.id === selectedId));
      if (!inFilter(h)) l.setStyle({ opacity: 0.3, fillOpacity: 0.06 });
      if (h.id === selectedId) l.bringToFront();
    }
  }

  function syncHandles() {
    handles.forEach((m) => m.remove());
    handles = [];
    const sel = selected();
    if (!sel || mode !== 'select') return;
    sel.points.forEach((pt, i) => {
      const m = L.marker(pt, {
        draggable: true,
        icon: L.divIcon({ className: 'vhandle', iconSize: [16, 16] }),
      }).addTo(map);
      m.on('drag', () => {
        const ll = m.getLatLng();
        sel.points[i] = [ll.lat, ll.lng];
        layers.get(sel.id).setLatLngs(sel.points);
        setDirty();
      });
      handles.push(m);
    });
  }

  function syncDraft() {
    if (draftLayer) { draftLayer.remove(); draftLayer = null; }
    if (!draft.length) return;
    draftLayer = L.layerGroup().addTo(map);
    const shape = draft.length > 2 ? L.polygon : L.polyline;
    shape(draft, { color: '#e0a800', fillColor: '#ffd34d', fillOpacity: 0.3, weight: 2, interactive: false }).addTo(draftLayer);
    draft.forEach((pt, i) => {
      const c = L.circleMarker(pt, { radius: i === 0 ? 8 : 4, color: '#222', weight: 1.5, fillColor: i === 0 ? '#ffd34d' : '#fff', fillOpacity: 1, interactive: i === 0 && draft.length >= 3 });
      if (i === 0) c.on('click', (e) => { L.DomEvent.stopPropagation(e); finishDraft(); });
      c.addTo(draftLayer);
    });
  }

  function render() {
    const st = overlayState();
    syncPolygons(); syncHandles(); syncDraft(); renderPanel(); renderStats(st); syncOverlay(st);
  }

  function renderPanel() {
    const sel = selected();
    $('props').classList.toggle('hidden', !sel);
    if (sel) {
      if (document.activeElement !== $('p-street')) $('p-street').value = sel.street || '';
      if (document.activeElement !== $('p-number')) $('p-number').value = sel.number || '';
      if (document.activeElement !== $('p-note')) $('p-note').value = sel.note;
      document.querySelectorAll('#p-status button').forEach((b) => b.classList.toggle('active', b.dataset.status === sel.status));
    }
    renderStreets();
    const shown = houses.filter(inFilter).sort(Wijk.compareHouses);
    $('count').textContent = filterStreet ? `${shown.length} van ${houses.length}` : houses.length;
    $('list').replaceChildren(...shown.map((h) => {
      const d = document.createElement('div');
      d.className = h.id === selectedId ? 'sel' : '';
      d.innerHTML = `<i class="dot ${h.status}"></i>`;
      d.append(nameOf(h, houses.indexOf(h)));
      d.onclick = () => { setMode('select'); select(h.id); map.fitBounds(L.latLngBounds(h.points).pad(1.5), { maxZoom: 19 }); };
      return d;
    }));
    hint();
  }

  // Straten-filter en suggesties voor het straatveld
  function renderStreets() {
    const streets = [...new Set(houses.map((h) => h.street).filter(Boolean))].sort(Wijk.natCompare);
    const sel = $('street-filter');
    const want = [['', 'Alle straten'], ...streets.map((x) => [x, x])];
    if (houses.some((h) => !h.street)) want.push([NO_STREET, '(zonder straat)']);
    if (filterStreet && !want.some(([v]) => v === filterStreet)) filterStreet = '';
    if (sel.options.length !== want.length || [...sel.options].some((o, i) => o.value !== want[i][0])) {
      sel.replaceChildren(...want.map(([v, t]) => Object.assign(document.createElement('option'), { value: v, textContent: t })));
    }
    sel.value = filterStreet;
    $('street-list').replaceChildren(...streets.map((x) => Object.assign(document.createElement('option'), { value: x })));
  }

  // Actieve (of laatst gebruikte) straat: nieuwe huizen krijgen die straat vooraf ingevuld.
  let activeStreet = '';
  function setActiveStreet(v) {
    activeStreet = String(v || '').trim();
    if (document.activeElement !== $('active-street')) $('active-street').value = activeStreet;
  }

  function select(id) {
    selectedId = id;
    const h = selected();
    if (h) {
      if (h.street) setActiveStreet(h.street);
      else if (!h.number && activeStreet) { h.street = activeStreet; setDirty(); } // nieuw, nog leeg huis: straat alvast invullen
    }
    render();
  }

  // Dubbelklik/lang indrukken: in de weergave de popup (status, QR, delen), in bewerken het huis selecteren.
  function houseAction(id) {
    if (editing) editHouse(id);
    else openHouseDialog(id, { withStatus: true });
  }

  function editHouse(id) {
    setMode('select');
    select(id);
    if (matchMedia('(pointer: fine)').matches) $('p-number').focus();
  }

  const insidePoly = (pt, poly) => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [yi, xi] = poly[i], [yj, xj] = poly[j];
      if ((yi > pt.lat) !== (yj > pt.lat) && pt.lng < ((xj - xi) * (pt.lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };

  // Touchscreen: lang indrukken op een huis doet hetzelfde als dubbelklikken.
  function initLongPress() {
    const el = map.getContainer();
    let timer = null, start = null, swallow = false;
    const cancel = () => { clearTimeout(timer); timer = null; };
    el.addEventListener('pointerdown', (e) => {
      cancel();
      if (e.pointerType !== 'touch' || !e.isPrimary || (mode === 'draw' && draft.length) || overlayState()) return;
      start = { x: e.clientX, y: e.clientY };
      timer = setTimeout(() => {
        timer = null;
        const r = el.getBoundingClientRect();
        const ll = map.containerPointToLatLng([start.x - r.left, start.y - r.top]);
        const h = houses.find((x) => insidePoly(ll, x.points));
        if (h) { swallow = true; setTimeout(() => { swallow = false; }, 800); navigator.vibrate?.(30); houseAction(h.id); }
      }, 600);
    });
    el.addEventListener('pointermove', (e) => { if (timer && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) cancel(); });
    for (const t of ['pointerup', 'pointercancel']) el.addEventListener(t, cancel);
    for (const t of ['click', 'contextmenu']) el.addEventListener(t, (e) => { if (swallow) { e.preventDefault(); e.stopPropagation(); } }, true);
  }

  function setMode(m) {
    mode = m;
    draft = [];
    $('t-select').classList.toggle('active', m === 'select');
    $('t-draw').classList.toggle('active', m === 'draw');
    $('vp').classList.toggle('drawing', m === 'draw');
    if (m === 'draw') { selectedId = null; map.doubleClickZoom.disable(); } else map.doubleClickZoom.enable();
    render();
  }

  function finishDraft() {
    if (draft.length < 3) { toast('Een huis heeft minstens 3 punten nodig'); return; }
    const lastStreet = activeStreet || (filterStreet && filterStreet !== NO_STREET ? filterStreet : (houses[houses.length - 1]?.street || ''));
    const h = { id: uid(), street: lastStreet, number: '', note: '', status: newStatus, points: draft };
    houses.push(h);
    draft = [];
    selectedId = h.id;
    setDirty();
    render();
    if (matchMedia('(pointer: fine)').matches) $('p-number').focus();
  }

  function onMapClick(e) {
    if (mode === 'draw') {
      const last = draft[draft.length - 1];
      if (last && map.latLngToContainerPoint(e.latlng).distanceTo(map.latLngToContainerPoint(last)) < 3) return; // dubbelklik
      draft.push([e.latlng.lat, e.latlng.lng]);
      render();
    } else {
      select(null);
    }
  }

  // Opslaan gaat naar de kaart die bewerkt wordt: de live kaart, of (met een eigen API-adres) alleen de editie.
  async function save() {
    const target = editTarget;
    try {
      if (target === LIVE) {
        const res = await api('/api/admin/houses', { method: 'PUT', body: JSON.stringify({ houses }), expectAuth: true });
        houses = res.houses;
        toast('Opgeslagen ✔');
      } else {
        const res = await api(`/api/admin/editions/${target}/houses`, { method: 'PUT', body: JSON.stringify({ houses }), expectAuth: true });
        if (editTarget !== target) return; // intussen gestopt met bewerken
        houses = res.houses;
        editionHouses.set(target, JSON.parse(JSON.stringify(res.houses)));
        setEditionCounts(target, res.counts);
        toast(tName('Opgeslagen in {naam} ✔', {}, keyLabel(target)));
      }
      setDirty(false);
      render();
    } catch (e) { toast(e.message); }
  }

  // ---------- kaartweergave ----------
  let savedView = null;
  const num = (id) => Number(String($(id).value).replace(',', '.'));
  function fillView(v) {
    $('v-lat').value = v.center[0];
    $('v-lng').value = v.center[1];
    $('v-zoom').value = v.zoom;
    $('v-min').value = v.minZoom ?? 1;
    $('v-max').value = v.maxZoom ?? 19;
    $('v-numbers').checked = !!v.showNumbers;
  }
  const grabView = () => {
    const c = map.getCenter();
    $('v-lat').value = Math.round(c.lat * 1e6) / 1e6;
    $('v-lng').value = Math.round(c.lng * 1e6) / 1e6;
    $('v-zoom').value = Math.round(map.getZoom() * 4) / 4;
  };
  const readView = () => ({ center: [num('v-lat'), num('v-lng')], zoom: num('v-zoom'), minZoom: num('v-min'), maxZoom: num('v-max'), showNumbers: $('v-numbers').checked });
  function updateNow() {
    $('v-now').textContent = `Kaart nu: zoom ${map.getZoom()} · ${savedView ? 'startweergave is ingesteld' : 'geen startweergave: de site toont automatisch alle huizen'}`;
  }

  // ---------- kaartvlak van de PDF ----------
  let savedPdf = null, draftPdf = null, pdfBox = null;
  const pdfNow = () => {
    const v = draftPdf || savedPdf;
    $('pdf-now').textContent = v
      ? I18n.t(draftPdf ? 'PDF-vlak: zoom {n} (nog niet opgeslagen)' : 'PDF-vlak: zoom {n} (opgeslagen)', { n: v.zoom })
      : I18n.t('Geen PDF-vlak ingesteld: de PDF toont automatisch alle huizen.');
  };
  function showPdfBox(fit) {
    if (pdfBox) { pdfBox.remove(); pdfBox = null; }
    const { bounds } = Wijk.pdfBounds(houses, savedView, draftPdf || savedPdf);
    pdfBox = L.rectangle(bounds, { color: '#d9480f', weight: 3, dashArray: '8 6', fill: false, interactive: false }).addTo(map);
    if (fit) map.fitBounds(bounds, { padding: [20, 20] });
  }
  function wirePdfView() {
    $('pdf-show').onclick = () => { showPdfBox(true); pdfNow(); };
    $('pdf-grab').onclick = () => {
      // zoom zo kiezen dat de PDF (breedte PDF_W px) het gebied van de huidige kaart toont
      const w = map.getSize().x;
      const zoom = Math.min(19, Math.max(1, Math.round(map.getZoom() + Math.log2(Wijk.PDF_W / w))));
      const c = map.getCenter();
      draftPdf = { center: [Math.round(c.lat * 1e6) / 1e6, Math.round(c.lng * 1e6) / 1e6], zoom };
      showPdfBox(false); pdfNow();
    };
    $('pdf-save').onclick = async () => {
      $('v-err').textContent = '';
      if (!draftPdf && !savedPdf) { $('v-err').textContent = 'Neem eerst de huidige kaart over als PDF-vlak.'; return; }
      try {
        const res = await api('/api/admin/pdf-view', { method: 'PUT', body: JSON.stringify(draftPdf || savedPdf), expectAuth: true });
        savedPdf = res.pdfView; draftPdf = null;
        showPdfBox(false); pdfNow();
        toast('PDF-kaartvlak opgeslagen ✔');
      } catch (e) { $('v-err').textContent = e.message; }
    };
    $('pdf-auto').onclick = async () => {
      if (!confirmT('Het PDF-vlak wissen? De PDF toont dan automatisch alle huizen.')) return;
      try {
        await api('/api/admin/pdf-view', { method: 'DELETE', expectAuth: true });
        savedPdf = null; draftPdf = null;
        showPdfBox(false); pdfNow();
        toast('PDF-vlak gewist');
      } catch (e) { $('v-err').textContent = e.message; }
    };
  }

  function wireView() {
    wirePdfView();
    $('view-open').onclick = () => {
      $('v-err').textContent = '';
      if (savedView) fillView(savedView); else { fillView({ center: [0, 0], zoom: 17 }); grabView(); }
      updateNow();
      draftPdf = null; pdfNow();
      $('view-dialog').showModal();
    };
    $('view-grab').onclick = () => { grabView(); updateNow(); };
    $('v-close').onclick = () => $('view-dialog').close();
    $('view-dialog').addEventListener('close', () => { if (pdfBox) { pdfBox.remove(); pdfBox = null; } });
    $('v-apply').onclick = () => {
      const v = readView();
      if (v.center.every(Number.isFinite) && Number.isFinite(v.zoom)) map.setView(v.center, Math.min(19, Math.max(1, v.zoom)));
      updateNow();
    };
    $('v-save').onclick = async () => {
      $('v-err').textContent = '';
      try {
        const res = await api('/api/admin/view', { method: 'PUT', body: JSON.stringify(readView()), expectAuth: true });
        savedView = res.view;
        $('view-dialog').close();
        toast('Kaartweergave opgeslagen ✔');
      } catch (e) { $('v-err').textContent = e.message; }
    };
    $('v-auto').onclick = async () => {
      if (!confirmT('De startweergave wissen? De site toont dan automatisch alle huizen.')) return;
      try {
        await api('/api/admin/view', { method: 'DELETE', expectAuth: true });
        savedView = null;
        $('view-dialog').close();
        toast('Startweergave gewist');
      } catch (e) { $('v-err').textContent = e.message; }
    };
  }

  async function search(q) {
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=nl&q=${encodeURIComponent(q)}`, { headers: { 'Accept-Language': 'nl' } });
      const [hit] = await r.json();
      if (!hit) return toast('Niets gevonden');
      const bb = hit.boundingbox.map(Number);
      map.fitBounds([[bb[0], bb[2]], [bb[1], bb[3]]], { maxZoom: 18 });
    } catch { toast('Zoeken mislukt'); }
  }

  // Deelnemers van de community (alleen als die aanstaat): paarse stippen op de beheerkaart met het aantal in de zijbalk.
  let communityLayer = null;
  async function pollCommunity() {
    if (!communityLayer || document.hidden) return;
    try {
      const { enabled, participants } = await api('/api/admin/community');
      const chip = $('a-community');
      if (!enabled) { communityLayer.clear(); chip.hidden = true; return; }
      communityLayer.update(participants);
      chip.hidden = false;
      chip.textContent = participants.length === 1 ? 'Community: 1 deelnemer deelt zijn of haar positie' : `Community: ${participants.length} deelnemers delen hun positie`;
    } catch { /* offline of uitgelogd: volgende poging */ }
  }

  // ---------- edities: de kaart van elke keer bekijken, vergelijken en bewerken ----------
  // De live kaart is wat de voorpagina toont. Een editie is de kaart van één keer, met naam, jaartal en eigen statussen.
  // In de weergave kies je in de overzichtskaart welke kaart je ziet en waarmee je vergelijkt. "Bewerken" werkt op de
  // gekozen kaart: bij een editie bewerk je een kopie van die editie, en Opslaan schrijft alleen naar die editie
  // (een eigen API-adres), zodat de live kaart nooit geraakt wordt.
  const LIVE = 'live';
  let editionList = []; // [{ id, name, year, createdAt, updatedAt, copiedFrom, counts }], nieuwste jaar eerst
  const editionHouses = new Map(); // id -> huizen (pas opgehaald als je de editie bekijkt)
  let showId = LIVE, cmpId = ''; // wat de kaart toont, en waarmee vergeleken wordt ('' = niet vergelijken)
  let editTarget = LIVE, liveStash = null; // wat het bewerkscherm bewerkt; de live huizen staan zolang in liveStash
  let overlay = null, overlayKey = '', overlayDrawn = [];
  const liveList = () => (editTarget === LIVE ? houses : liveStash); // altijd de huizen van de live kaart
  const edById = (id) => editionList.find((e) => e.id === id);
  // "Sint Maarten" + 2025 -> "Sint Maarten 2025" (staat het jaartal al in de naam, dan niet dubbel)
  const edLabel = (e) => (e.name.includes(String(e.year)) ? e.name : `${e.name} ${e.year}`);
  // Sjabloon vertalen met een eigen naam erin; de naam zelf blijft zoals de beheerder hem schreef (geen vertaling of vervanging).
  const tName = (tpl, vars, name) => I18n.t(tpl, { ...vars, naam: '\u0001' }).replace('\u0001', name);
  const keyLabel = (id) => (id === LIVE ? I18n.tr('Live') : edLabel(edById(id) || { name: '?', year: '' }));
  const housesSync = (id) => (id === LIVE ? liveList() : editionHouses.get(id) || []);
  async function housesOf(id) {
    if (id !== LIVE && !editionHouses.has(id)) editionHouses.set(id, (await api(`/api/admin/editions/${id}`, { expectAuth: true })).houses);
    return housesSync(id);
  }
  const setEditionCounts = (id, counts) => { const e = edById(id); if (e && counts) e.counts = counts; };
  // Volgorde in de tijd: eerst het jaartal, dan wanneer de editie aangemaakt is; de live kaart is altijd de nieuwste.
  const timeKey = (id) => (id === LIVE ? [Infinity, ''] : [edById(id)?.year ?? 0, edById(id)?.createdAt ?? '']);
  const olderThan = (x, y) => { const a = timeKey(x), b = timeKey(y); return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]); };

  // Wat de kaart nu toont: null = de huizen van het bewerkscherm (live, of de editie die je bewerkt); anders één
  // editie in de weergave, of een vergelijking van twee kaarten.
  function overlayState() {
    if (editing || (showId === LIVE && !cmpId)) return null;
    if (!cmpId) return { mode: 'single', pairs: SMCompare.match(housesSync(showId), liveList()).filter((p) => p.a) };
    const [oldId, newId] = olderThan(showId, cmpId) ? [showId, cmpId] : [cmpId, showId];
    return { mode: 'compare', oldId, newId, shownIsOld: oldId === showId, ...SMCompare.compare(housesSync(oldId), housesSync(newId)) };
  }

  // Kleuren in de vergelijking: groen in beide, alleen in de oudere (gestopt) of alleen in de nieuwere (nieuw).
  const CMP_STYLE = {
    both: { color: '#0f6b36', fillColor: '#1f9d55', fillOpacity: 0.6, weight: 2 },
    onlyA: { color: '#9c4a00', fillColor: '#f08c00', fillOpacity: 0.65, weight: 2 },
    onlyB: { color: '#14508f', fillColor: '#1c7ed6', fillOpacity: 0.6, weight: 2 },
    neither: { color: '#666666', fillColor: '#888888', fillOpacity: 0.12, weight: 1.5, dashArray: '5 4' },
  };
  const statusName = (h) => (h ? Wijk.STATUS[h.status]?.name || Wijk.STATUS.none.name : I18n.tr('niet op de kaart'));

  // Popup bij een huis van een editie of vergelijking: adres en de status in elk van de twee kaarten. Bij één editie
  // (niet bij vergelijken) staan er ook knoppen om de status in die editie meteen te wijzigen.
  function overlayPopup(h, lines, quick) {
    const box = document.createElement('div');
    box.className = 'ed-pop';
    box.setAttribute('data-i18n-skip', '');
    const t = document.createElement('strong');
    t.textContent = Wijk.houseTitle(h);
    box.append(t);
    for (const [label, other] of lines) {
      const row = document.createElement('div');
      const dot = document.createElement('i');
      dot.className = `dot ${other ? other.status : ''}`;
      if (!other) dot.classList.add('gone');
      const name = document.createElement('span');
      name.textContent = `${label}: `;
      const val = document.createElement('b');
      val.textContent = statusName(other);
      row.append(dot, name, val);
      box.append(row);
    }
    if (quick) {
      const seg = document.createElement('div');
      seg.className = 'row seg ed-pop-status';
      seg.setAttribute('role', 'group');
      seg.setAttribute('aria-label', tName('Status in {naam}', {}, keyLabel(quick.id)));
      for (const st of ['green', 'red', 'none']) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = h.status === st ? 'active' : '';
        b.append(Object.assign(document.createElement('i'), { className: `dot ${st}` }), Wijk.STATUS[st].name);
        b.onclick = () => quick.set(st, seg);
        seg.append(b);
      }
      box.append(seg);
    }
    return box;
  }

  // Snelle statuswijziging vanuit de popup: alleen in de editie die op de kaart staat (eigen API-adres).
  async function quickStatus(id, h, st, poly, seg) {
    if (h.status === st) return;
    const next = (editionHouses.get(id) || []).map((x) => (x.id === h.id ? { ...x, status: st } : x));
    seg.querySelectorAll('button').forEach((b) => (b.disabled = true));
    try {
      const res = await api(`/api/admin/editions/${id}/houses`, { method: 'PUT', body: JSON.stringify({ houses: next }), expectAuth: true });
      h.status = st; // hetzelfde object als in de cache: popup, kaart en aantallen lopen zo gelijk
      setEditionCounts(id, res.counts);
      poly.setStyle(Wijk.houseStyle(st, false));
      poly.getPopup()?.update();
      numsBuilt = '';
      render();
      toast(tName('Opgeslagen in {naam} ✔', {}, keyLabel(id)));
    } catch (e) {
      toast(e.message);
      seg.querySelectorAll('button').forEach((b) => (b.disabled = false));
    }
  }

  function syncOverlay(st) {
    const key = st ? `${showId}|${cmpId}|${numsRev}` : '';
    if (key !== overlayKey) {
      overlayKey = key;
      overlay.clearLayers();
      overlayDrawn = [];
      map.closePopup();
      if (st && map.hasLayer(liveGroup)) map.removeLayer(liveGroup);
      if (!st && !map.hasLayer(liveGroup)) liveGroup.addTo(map);
      // een popup mag niet achter de overzichtskaart rechtsboven vallen (op een smalle telefoon kan dat niet anders)
      const cardW = $('house-stats').offsetWidth;
      const popupOpts = { maxWidth: 300, autoPanPaddingBottomRight: L.point(cardW && cardW < map.getSize().x / 2 ? cardW + 24 : 5, 5) };
      const shown = showId;
      for (const p of st ? st.pairs : []) {
        let h, style, lines, quick = null, poly;
        if (st.mode === 'single') {
          h = p.a; style = Wijk.houseStyle(h.status, false);
          lines = [[keyLabel(shown), p.a], [keyLabel(LIVE), p.b]];
          quick = { id: shown, set: (s, seg) => quickStatus(shown, h, s, poly, seg) };
        } else {
          h = (st.shownIsOld ? p.a : p.b) || p.a || p.b; style = CMP_STYLE[p.cat];
          lines = [[keyLabel(st.oldId), p.a], [keyLabel(st.newId), p.b]];
        }
        poly = L.polygon(h.points, style).addTo(overlay);
        poly.bindPopup(() => overlayPopup(h, lines, quick), popupOpts);
        poly.on('click', (e) => L.DomEvent.stopPropagation(e));
        overlayDrawn.push(h);
      }
    }
    const want = st ? `ov|${overlayKey}` : `${editTarget}|${numsRev}`;
    if (nums && numsBuilt !== want) { nums.rebuild(st ? overlayDrawn : houses); numsBuilt = want; }
  }

  // De hint onderaan de kaart hoort bij wat er getoond wordt (live: popup met QR; editie: status wijzigen of vergelijken).
  let hintFor = null;
  function syncViewHint(mode) {
    if (hintFor === mode) return;
    hintFor = mode;
    $('view-hint').textContent = mode === 'single'
      ? 'Klik of tik op een huis om de status in deze editie te wijzigen'
      : mode === 'compare'
        ? 'Klik of tik op een huis voor de status in elke kaart'
        : 'Dubbelklik (of druk lang) op een huis voor de status en de QR-code';
  }
  let statsFolded = false;
  try { statsFolded = localStorage.getItem('sm-admin-stats-folded') === '1'; } catch {}
  function syncFold() {
    $('hs-fold').setAttribute('aria-expanded', String(!statsFolded));
    $('hs-fold').replaceChildren(MDI.svg(statsFolded ? 'chevron-down' : 'chevron-up'), Object.assign(document.createElement('span'), { textContent: statsFolded ? 'Aantallen tonen' : 'Aantallen verbergen' }));
  }
  $('hs-fold').onclick = () => {
    statsFolded = !statsFolded;
    try { localStorage.setItem('sm-admin-stats-folded', statsFolded ? '1' : '0'); } catch {}
    syncFold();
    if (map) renderStats();
  };
  syncFold();

  // Overzichtskaart rechtsboven: keuze van de kaart, de aantallen, en bij vergelijken het verschil.
  function renderStats(st = map ? overlayState() : null) {
    syncViewHint(st ? st.mode : null);
    const list = st && st.mode === 'single' ? st.pairs.map((p) => p.a) : houses;
    Wijk.renderStats(list, statsShow);
    const withEditions = editionList.length > 0 && !editing;
    const comparing = !!st && st.mode === 'compare';
    $('hs-editions').hidden = !withEditions;
    $('hs-ed-note').hidden = !st;
    $('hs-plain').hidden = comparing || !list.length;
    $('hs-empty').hidden = comparing || list.length > 0 || !withEditions;
    $('hs-compare').hidden = !comparing;
    $('house-stats').classList.toggle('comparing', comparing);
    $('house-stats').classList.toggle('folded', statsFolded && withEditions); // zonder edities valt er niets in te klappen
    if (withEditions) $('house-stats').hidden = false;
    if (comparing) renderCompare(st);
  }

  function renderCompare(st) {
    const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
    const sign = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '±0');
    const head = el('div', 'hs-cmp-head');
    head.append(el('span', '', keyLabel(st.oldId)), el('span', 'hs-arrow', '→'), el('span', '', keyLabel(st.newId)));
    const grid = el('div', 'hs-cmp-grid');
    const row = (dotCls, name, a, b) => {
      const n = el('span', 'hs-name');
      if (dotCls !== null) n.append(el('i', `dot ${dotCls}`));
      n.append(name);
      const d = el('span', `hs-delta${b > a ? ' up' : b < a ? ' down' : ''}`, sign(b - a));
      grid.append(n, el('b', '', String(a)), el('span', 'hs-arrow', '→'), el('b', '', String(b)), d);
    };
    row(null, I18n.tr('Totaal'), st.a.total, st.b.total);
    for (const k of ['green', 'red', 'none']) if (statsShow[k] && (k !== 'none' || st.a.none || st.b.none)) row(k, Wijk.STATUS[k].name, st.a[k], st.b[k]);
    const legend = el('div', 'hs-cmp-legend');
    const green = Wijk.STATUS.green.name;
    for (const [cat, text] of [
      ['both', I18n.t('{status} in beide', { status: green })],
      ['onlyA', tName('{status} alleen in {naam}', { status: green }, keyLabel(st.oldId))],
      ['onlyB', tName('{status} alleen in {naam}', { status: green }, keyLabel(st.newId))],
      ['neither', I18n.tr('Overige huizen')],
    ]) {
      const r = el('div', `hs-row${cat === 'neither' ? ' hs-none' : ''}`);
      r.append(el('i', `swatch ${cat}`), el('span', 'hs-name', text), el('b', '', String(st.cats[cat])));
      legend.append(r);
    }
    $('hs-compare').replaceChildren(head, grid, legend);
  }

  // Opties: de live kaart en alle edities (eigen namen worden niet vertaald).
  function editionOptions(skip) {
    const opt = (value, text, isName) => {
      const o = Object.assign(document.createElement('option'), { value, textContent: text });
      if (isName) o.setAttribute('data-i18n-skip', '');
      return o;
    };
    return [[LIVE, I18n.tr('Live (voorpagina)'), false], ...editionList.map((e) => [e.id, edLabel(e), true])]
      .filter(([v]) => v !== skip).map(([v, t, n]) => opt(v, t, n));
  }
  function fillEditionSelects() {
    $('hs-show').replaceChildren(...editionOptions());
    $('hs-show').value = showId;
    $('hs-cmp').replaceChildren(Object.assign(document.createElement('option'), { value: '', textContent: I18n.tr('Niet vergelijken') }), ...editionOptions(showId));
    $('hs-cmp').value = cmpId;
  }

  async function setShown(show, cmp) {
    try {
      await housesOf(show);
      if (cmp) await housesOf(cmp);
    } catch (e) { toast(e.message); show = LIVE; cmp = ''; }
    showId = show; cmpId = cmp === show ? '' : cmp;
    fillEditionSelects();
    render();
  }
  $('hs-show').onchange = () => setShown($('hs-show').value, cmpId);
  $('hs-cmp').onchange = () => setShown(showId, $('hs-cmp').value);

  async function loadEditions() {
    try { editionList = await api('/api/admin/editions', { expectAuth: true }); } catch { return; }
    if (editTarget !== LIVE && !edById(editTarget)) { // de editie die je bewerkte bestaat niet meer
      toast(I18n.tr('Deze editie bestaat niet meer; terug naar de live kaart'));
      leaveEditing();
    }
    if (showId !== LIVE && !edById(showId)) showId = LIVE;
    if (cmpId && cmpId !== LIVE && !edById(cmpId)) cmpId = '';
    for (const id of editionHouses.keys()) if (!edById(id)) editionHouses.delete(id);
    fillEditionSelects();
    if (map) { overlayKey = '-'; syncEditTarget(); render(); } // namen kunnen veranderd zijn: popups en overzicht opnieuw opbouwen
  }

  // ---- bewerken: de live kaart of een editie ----
  // Kaartvlakken opnieuw opbouwen: een editie kan dezelfde id's hebben als de live kaart maar een andere vorm.
  function resetLayers() {
    liveGroup.clearLayers(); layers.clear();
    handles.forEach((m) => m.remove()); handles = [];
    selectedId = null; draft = [];
    touchHouses();
  }
  // Wat er bewerkt wordt, bovenaan de zijbalk en op de knop Opslaan.
  function syncEditTarget() {
    const ed = editTarget !== LIVE;
    const box = $('edit-target');
    box.classList.toggle('is-edition', ed);
    const name = Object.assign(document.createElement('b'), { textContent: keyLabel(editTarget) });
    if (ed) name.setAttribute('data-i18n-skip', '');
    box.replaceChildren(
      Object.assign(document.createElement('span'), { textContent: ed ? I18n.tr('Je bewerkt de editie') : I18n.tr('Je bewerkt de live kaart (voorpagina)') }),
      ...(ed ? [' ', name, Object.assign(document.createElement('small'), { textContent: I18n.tr('Opslaan bewaart alleen in deze editie; de voorpagina verandert niet.') })] : []),
    );
    // op een smal scherm alleen "Opslaan" (de melding in de zijbalk zegt al dat het om de editie gaat)
    $('save').replaceChildren(...(ed ? [Object.assign(document.createElement('span'), { className: 'lbl-long', textContent: 'Editie opslaan' }), Object.assign(document.createElement('span'), { className: 'lbl-short', textContent: 'Opslaan' })] : ['Opslaan']));
    $('save').classList.toggle('is-edition', ed);
    $('p-qr').classList.toggle('hidden', ed); // QR-codes horen bij de live kaart
  }
  // Bewerken starten op de kaart die gekozen is (bij vergelijken: de kaart bij "Kaart").
  async function startEditing() {
    const target = showId;
    if (target !== LIVE) {
      try { await housesOf(target); } catch (e) { toast(e.message); return; }
      liveStash = houses;
      houses = JSON.parse(JSON.stringify(editionHouses.get(target))); // een kopie: pas Opslaan schrijft naar de editie
    }
    editTarget = target; cmpId = '';
    resetLayers();
    setDirty(false);
    syncEditTarget();
    setEditing(true);
  }
  // Terug naar de weergave; niet-opgeslagen wijzigingen in een editie vervallen (de editie zelf is niet aangeraakt).
  function leaveEditing() {
    if (editTarget !== LIVE) { houses = liveStash; liveStash = null; }
    editTarget = LIVE;
    resetLayers();
    setDirty(false);
    syncEditTarget();
    setEditing(false);
  }
  // Vanuit de lijst in de instellingen: een kaart bekijken of bewerken.
  async function viewEdition(id, edit = false) {
    if (editing) {
      await $('edit-toggle').onclick(); // vraagt zelf om bevestiging bij niet-opgeslagen wijzigingen
      if (editing) return;
    }
    closeSettings();
    await setShown(id, id === LIVE || edit ? '' : cmpId);
    if (edit && showId === id) await startEditing();
  }

  // ---- tab Edities ----
  const fmtDay = (iso) => new Date(iso).toLocaleDateString(I18n.locale, { dateStyle: 'medium' });
  const noFill = (el) => { el.setAttribute('autocomplete', 'off'); el.setAttribute('data-lpignore', 'true'); el.setAttribute('data-1p-ignore', ''); el.setAttribute('data-bwignore', 'true'); return el; };
  const selectedEditions = () => [...document.querySelectorAll('#ed-list input[type=checkbox]:checked')].map((c) => c.value);
  const syncEditionButtons = () => { $('ed-delete').disabled = selectedEditions().length === 0; };

  // Aantallen als kleine bolletjes: totaal, groen, rood en (als die er zijn) niet gemarkeerd.
  function countChips(c) {
    const wrap = document.createElement('span');
    wrap.className = 'ed-counts';
    wrap.append(Object.assign(document.createElement('span'), { textContent: I18n.t('{n} huizen', { n: c.total }) }));
    for (const k of ['green', 'red', 'none']) {
      if (k === 'none' && !c.none) continue;
      const chip = document.createElement('span');
      chip.className = 'ed-chip';
      chip.title = Wijk.STATUS[k].name;
      const dot = document.createElement('i');
      dot.className = `dot ${k}`;
      const pct = c.total && k === 'green' ? ` (${Math.round((c[k] / c.total) * 100)}%)` : '';
      chip.append(dot, `${c[k]}${pct}`);
      wrap.append(chip);
    }
    return wrap;
  }

  // Tweede regel bij een editie: wanneer aangemaakt, waarvan het een kopie is en of hij daarna bewerkt is.
  function editionSub(e) {
    const parts = [e.copiedFrom
      ? tName('Aangemaakt {datum} als kopie van {naam}', { datum: fmtDay(e.createdAt) }, e.copiedFrom.id === LIVE ? I18n.tr('Live') : e.copiedFrom.label)
      : I18n.t('Aangemaakt {datum}', { datum: fmtDay(e.createdAt) })];
    if (e.updatedAt) parts.push(I18n.t('bewerkt {datum}', { datum: fmtDay(e.updatedAt) }));
    return parts.join(' · ');
  }

  function editionRow(e) {
    const row = document.createElement('div');
    row.className = 'bk-row ed-row';
    const live = e.id === LIVE;
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.value = e.id; cb.onchange = syncEditionButtons;
    cb.setAttribute('aria-label', live ? '' : tName('Selecteer editie {naam}', {}, edLabel(e)));
    cb.setAttribute('data-i18n-skip', '');
    if (live) cb.style.visibility = 'hidden';
    const info = document.createElement('div');
    info.className = 'bk-info';
    const title = document.createElement('strong');
    title.textContent = live ? I18n.tr('Live (voorpagina)') : edLabel(e);
    if (!live) title.setAttribute('data-i18n-skip', '');
    const sub = document.createElement('span');
    sub.className = 'ed-sub';
    sub.textContent = live ? I18n.tr(dirty && editTarget === LIVE ? 'Zoals nu op de kaart (nog niet opgeslagen)' : 'Zoals nu op de voorpagina') : editionSub(e);
    sub.setAttribute('data-i18n-skip', '');
    info.append(title, countChips(live ? SMCompare.counts(liveList()) : e.counts), sub);
    const btn = (icon, text, onclick) => {
      const b = document.createElement('button');
      b.append(MDI.svg(icon), Object.assign(document.createElement('span'), { textContent: I18n.tr(text) }));
      b.onclick = onclick;
      return b;
    };
    const actions = document.createElement('div');
    actions.className = 'ed-actions';
    actions.append(btn('eye-outline', 'Bekijken', () => viewEdition(e.id)), btn('pencil', 'Bewerken', () => viewEdition(e.id, true)));
    if (!live) {
      const ren = document.createElement('button');
      ren.append(MDI.svg('form-textbox')); ren.title = I18n.tr('Naam of jaartal wijzigen'); ren.setAttribute('aria-label', I18n.tr('Naam of jaartal wijzigen'));
      ren.onclick = () => editEditionRow(row, e, cb);
      actions.append(ren);
    }
    row.append(cb, info, actions);
    return row;
  }

  // Naam en jaartal in de regel zelf wijzigen.
  function editEditionRow(row, e, cb) {
    const form = document.createElement('div');
    form.className = 'bk-info ed-edit';
    const name = noFill(Object.assign(document.createElement('input'), { type: 'text', value: e.name, maxLength: 60 }));
    name.setAttribute('aria-label', I18n.tr('Naam'));
    const year = noFill(Object.assign(document.createElement('input'), { type: 'number', value: e.year, min: 1900, max: 2100, step: 1 }));
    year.setAttribute('aria-label', I18n.tr('Jaartal'));
    form.append(name, year);
    const ok = Object.assign(document.createElement('button'), { className: 'primary', textContent: I18n.tr('Opslaan') });
    const cancel = Object.assign(document.createElement('button'), { textContent: I18n.tr('Annuleren') });
    const saveEdit = async () => {
      $('ed-list-err').textContent = '';
      try {
        await api(`/api/admin/editions/${e.id}`, { method: 'PUT', body: JSON.stringify({ name: name.value, year: year.value }), expectAuth: true });
        toast(I18n.tr('Editie bijgewerkt ✔'));
        renderEditions();
      } catch (err) { $('ed-list-err').textContent = err.message; }
    };
    ok.onclick = saveEdit;
    cancel.onclick = () => renderEditions();
    for (const inp of [name, year]) inp.onkeydown = (ev) => { if (ev.key === 'Enter') saveEdit(); if (ev.key === 'Escape') { ev.stopPropagation(); renderEditions(); } };
    row.replaceChildren(cb, form, ok, cancel);
    name.focus();
  }

  async function renderEditions() {
    $('ed-err').textContent = ''; $('ed-list-err').textContent = '';
    if (!$('ed-year').value) $('ed-year').value = new Date().getFullYear();
    await loadEditions();
    const from = $('ed-from').value || LIVE;
    $('ed-from').replaceChildren(...editionOptions());
    $('ed-from').value = from === LIVE || edById(from) ? from : LIVE;
    $('ed-list').replaceChildren(editionRow({ id: LIVE }), ...editionList.map(editionRow));
    syncEditionButtons();
  }

  $('ed-save').onclick = async () => {
    $('ed-err').textContent = '';
    const from = $('ed-from').value || LIVE;
    if (from === LIVE && dirty && editTarget === LIVE && !confirmT('Er zijn niet-opgeslagen wijzigingen op de live kaart. De nieuwe editie krijgt de laatst opgeslagen stand. Toch aanmaken?')) return;
    try {
      const e = await post('/api/admin/editions', { name: $('ed-name').value, year: $('ed-year').value, from }, { expectAuth: true });
      $('ed-name').value = '';
      toast(tName('Editie {naam} aangemaakt ✔', {}, edLabel(e)));
      renderEditions();
    } catch (e) { $('ed-err').textContent = e.message; }
  };

  $('ed-delete').onclick = async () => {
    const ids = selectedEditions();
    if (!ids.length) return;
    if (!confirmT(`${ids.length} editie(s) definitief verwijderen? Je moet dit bevestigen met je ${confirmWord()}.`)) return;
    $('ed-list-err').textContent = '';
    try {
      const proof = await confirmStep();
      const res = await post('/api/admin/editions/delete', { ids, ...proof });
      toast(`${res.deleted} editie(s) verwijderd`);
      renderEditions();
    } catch (e) { $('ed-list-err').textContent = friendly(e); }
  };

  function initEditor(data) {
    if (map) { map.remove(); layers.clear(); handles = []; draftLayer = null; }
    $('vp').replaceChildren();
    savedView = data.view; savedPdf = data.pdfView || null;
    // in het beheer altijd het volledige zoombereik, ook als bezoekers beperkt zijn
    map = Wijk.createMap($('vp'), data.view && { ...data.view, minZoom: 1, maxZoom: 19 }, data.houses);
    Wijk.map = map;
    liveGroup = L.featureGroup().addTo(map);
    overlay = L.featureGroup().addTo(map);
    overlayKey = ''; numsBuilt = '';
    communityLayer = Wijk.createCommunityLayer(map);
    map.on('click', onMapClick);
    initLongPress();
    map.on('dblclick', () => { if (mode === 'draw' && draft.length >= 3) finishDraft(); });

    $('t-select').onclick = () => setMode('select');
    $('t-draw').onclick = () => setMode('draw');
    document.querySelectorAll('[data-newstatus]').forEach((b) => b.onclick = () => {
      newStatus = b.dataset.newstatus;
      document.querySelectorAll('[data-newstatus]').forEach((x) => x.classList.toggle('active', x === b));
    });
    document.querySelectorAll('#p-status button').forEach((b) => b.onclick = () => setStatus(b.dataset.status));
    $('p-street').oninput = () => { const s = selected(); if (s) { s.street = $('p-street').value; setActiveStreet(s.street); setDirty(); render(); } };
    $('active-street').oninput = () => setActiveStreet($('active-street').value);
    $('p-number').oninput = () => { const s = selected(); if (s) { s.number = $('p-number').value; setDirty(); render(); } };
    $('street-filter').onchange = () => {
      filterStreet = $('street-filter').value;
      if (filterStreet && filterStreet !== NO_STREET) setActiveStreet(filterStreet);
      render();
      const sub = houses.filter(inFilter);
      if (filterStreet && sub.length) map.fitBounds(L.latLngBounds(sub.flatMap((h) => h.points)).pad(0.3), { maxZoom: 19 });
    };
    // huisnummers midden op de huizen (alleen een weergavekeuze in het beheer)
    nums = Wijk.createNumberLayer(map);
    let showNums = true;
    try { showNums = localStorage.getItem('sm-admin-numbers') !== '0'; } catch {}
    $('a-num-switch').checked = showNums;
    nums.setVisible(showNums);
    $('a-num-switch').onchange = () => {
      nums.setVisible($('a-num-switch').checked);
      try { localStorage.setItem('sm-admin-numbers', $('a-num-switch').checked ? '1' : '0'); } catch {}
    };
    $('p-note').oninput = () => { const s = selected(); if (s) { s.note = $('p-note').value; setDirty(); } };
    $('p-del').onclick = deleteSelected;
    $('save').onclick = save;
    wireView();
    setActiveStreet(houses.length ? houses[houses.length - 1].street : '');
    $('search-form').onsubmit = (e) => { e.preventDefault(); if ($('search').value.trim()) search($('search').value.trim()); };

    if (!window.__keys) {
      window.__keys = true;
      document.addEventListener('keydown', (e) => {
        if (!map) return;
        if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName) && e.key !== 'Escape') return;
        if (document.querySelector('dialog[open]') || drawerOpen()) return;
        const k = e.key.toLowerCase();
        if ((e.ctrlKey || e.metaKey) && k === 's') { e.preventDefault(); save(); }
        else if (e.ctrlKey || e.metaKey || e.altKey) return;
        else if (!editing) return; // sneltoetsen voor bewerken alleen in het bewerkscherm
        else if (k === 'g' && selected()) setStatus('green');
        else if (k === 'r' && selected()) setStatus('red');
        else if (k === 'd') setMode(mode === 'draw' ? 'select' : 'draw');
        else if (k === 'delete' && selected()) deleteSelected();
        else if (k === 'enter' && mode === 'draw') finishDraft();
        else if (k === 'backspace' && mode === 'draw') { e.preventDefault(); draft.pop(); render(); }
        else if (k === 'escape') { document.activeElement.blur(); if (draft.length) { draft = []; render(); } else select(null); }
      });
    }
  }

  function setStatus(s) { const h = selected(); if (!h) return; h.status = s; setDirty(); render(); }
  function deleteSelected() {
    const h = selected();
    if (!h || !confirmT(`"${nameOf(h, houses.indexOf(h))}" verwijderen?`)) return;
    houses = houses.filter((x) => x !== h);
    selectedId = null; setDirty(); render();
  }

  async function reloadFromServer() {
    const raw = await api('/api/map');
    const data = I18n.localize(raw);
    if (editTarget === LIVE) houses = data.houses; else liveStash = data.houses; // een editie in bewerking blijft staan
    savedView = data.view; savedPdf = data.pdfView || null;
    org = { intro: raw.intro || '', logo: raw.logo, logoSmall: raw.logoSmall || null, favicon: raw.favicon || null, siteTitle: raw.siteTitle || '', appName: raw.appName || '', appShortName: raw.appShortName || '', labels: raw.labels };
    Wijk.setLabels(data.labels);
    selectedId = null; draft = [];
    setDirty(false);
    render();
    if (data.view) map.setView(data.view.center, data.view.zoom);
  }

  async function openEditor() {
    show('v-edit');
    const raw = await api('/api/map');
    const data = I18n.localize(raw);
    houses = data.houses;
    try { statsShow = (await api('/api/admin/settings', { expectAuth: true })).statsShow; } catch { /* standaard: alles tonen */ }
    org = { intro: raw.intro || '', logo: raw.logo, logoSmall: raw.logoSmall || null, favicon: raw.favicon || null, siteTitle: raw.siteTitle || '', appName: raw.appName || '', appShortName: raw.appShortName || '', labels: raw.labels };
    Wijk.setLabels(data.labels);
    initEditor(data);
    syncEditTarget();
    setDirty(false);
    setMode('select');
    setEditing(false); // standaard de weergave; "Bewerken" opent het bewerkscherm
    setTimeout(() => map.invalidateSize(), 0);
    pollChanges(true);
    pollCommunity();
    loadEditions();
    if (!window.__communityTimer) window.__communityTimer = setInterval(pollCommunity, 10000);
    if (!window.__pollTimer) window.__pollTimer = setInterval(() => pollChanges(), 30000);
    if (location.hash === '#changes') openSettings('changes');
  }

  // Gewone invoervelden niet door wachtwoordmanagers laten aanvullen of aanbieden.
  document.querySelectorAll('input:not([type=password]):not([type=file]):not([type=checkbox]), textarea, #s-token').forEach((el) => {
    el.setAttribute('autocomplete', 'off');
    el.setAttribute('data-lpignore', 'true');
    el.setAttribute('data-1p-ignore', '');
    el.setAttribute('data-bwignore', 'true');
    el.setAttribute('data-form-type', 'other');
  });

  // Een open uitnodiging (#invite=…) gaat voor; anders de editor, de installatie-wizard of het inlogscherm.
  async function boot() {
    const st = await api('/api/auth/status');
    session = st;
    if (inviteToken()) return showInvite(inviteToken());
    if (st.loggedIn) {
      signalPasskeyName(st.passkeyDetails);
      mountPwLogin(false);
      document.querySelector('#settings [data-tab="users"]').hidden = !st.user.owner;
      syncConfirmLabels();
      return openEditor();
    }
    if (!st.configured) return showWizard();
    showLogin(st);
  }
  window.addEventListener('hashchange', () => { if (inviteToken()) boot(); });
  boot().catch((e) => { document.body.textContent = e.message; });
})();
