/* 家和万事兴 · 我的账户 */
(function () {
  const $ = id => document.getElementById(id);
  const TOKEN = localStorage.getItem('token');

  if (!TOKEN) { window.location.href = '/login'; return; }

  const ROLE_LABEL = { admin: '管理员', branch_admin: '分支管理员', normal: '成员' };
  const ROLE_CLASS = { admin: 'role-admin', branch_admin: 'role-branch', normal: 'role-normal' };

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
  }

  function toast(message, isError) {
    const el = $('toast');
    el.textContent = message;
    el.classList.toggle('error', !!isError);
    el.classList.remove('hidden');
    requestAnimationFrame(() => el.classList.add('show'));
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.classList.add('hidden'), 220);
    }, 2400);
  }

  async function api(url, options) {
    const opts = Object.assign({}, options || {});
    opts.headers = Object.assign({
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + TOKEN,
    }, opts.headers || {});
    if (opts.body && typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      window.location.href = '/login';
      throw new Error('登录已过期');
    }
    if (!res.ok || data.ok === false) throw new Error(data.error || '请求失败');
    return data.data;
  }

  function identityText(g) {
    if (!g.member_name) return '未绑定谱成员';
    return `第 ${g.member_generation} 代 · ${g.member_name}`;
  }

  function badges(g) {
    const out = [];
    if (g.kind === 'kinship') out.push('<span class="role-pill role-kinship">亲戚谱</span>');
    if (g.is_default) out.push('<span class="role-pill role-default">默认指引</span>');
    out.push(`<span class="role-pill ${ROLE_CLASS[g.role] || 'role-normal'}">${ROLE_LABEL[g.role] || esc(g.role)}</span>`);
    if (g.kind !== 'kinship') {
      out.push(`<span class="role-pill role-normal">${g.visibility === 'public' ? '公开谱' : '私密谱'}</span>`);
    }
    return out.join('');
  }

  function rowHtml(g) {
    return `
      <div class="me-row">
        <div class="me-row-main">
          <div class="me-row-title">${esc(g.name)}${badges(g)}</div>
          <div class="me-row-meta">
            <span>成员 ${g.member_count || 0} 人</span>
            <span>身份：${esc(identityText(g))}</span>
            <span>创建于 ${esc((g.created_at || '').slice(0, 10))}</span>
          </div>
        </div>
        <button class="btn ghost" data-enter="${g.id}">进入</button>
      </div>`;
  }

  function emptyHtml(text) {
    return `<div class="me-empty">${esc(text)}</div>`;
  }

  function bindEnter(container) {
    container.querySelectorAll('button[data-enter]').forEach(btn => {
      btn.addEventListener('click', () => {
        localStorage.setItem('genealogy_id', btn.dataset.enter);
        window.location.href = '/';
      });
    });
  }

  function render(data) {
    const user = data.user || {};
    const list = data.genealogies || [];
    const managed = data.managed || list.filter(g => g.role === 'admin');
    const identities = data.identities || list.filter(g => g.member_id);
    const name = user.display_name || user.username || '用户';

    $('avatar').textContent = String(name).slice(0, 1);
    $('profileName').textContent = name;
    $('profileSub').textContent =
      `账号 ${user.username || '—'} · 加入 ${list.length} 个谱 · 管理 ${managed.length} 个谱`;

    const profileBadges = [];
    if (managed.length) profileBadges.push(`<span class="role-pill role-admin">管理员 × ${managed.length}</span>`);
    profileBadges.push(user.wechat_bound
      ? '<span class="role-pill role-branch">微信已绑定</span>'
      : '<span class="role-pill role-normal">微信未绑定</span>');
    profileBadges.push(user.phone
      ? '<span class="role-pill role-branch">手机号已绑定</span>'
      : '<span class="role-pill role-normal">手机号未绑定</span>');
    $('profileBadges').innerHTML = profileBadges.join('');

    const fields = [
      ['用户名', user.username || '—'],
      ['显示名', user.display_name || '—'],
      ['账号 ID', user.id == null ? '—' : String(user.id)],
      ['注册时间', (user.created_at || '—').slice(0, 10)],
      ['微信', user.wechat_bound ? '已绑定' : '未绑定'],
      ['手机号', user.phone ? user.phone : '未绑定'],
    ];
    $('accountGrid').innerHTML = fields.map(([label, value]) => `
      <div class="me-field">
        <label>${esc(label)}</label>
        <b>${esc(value)}</b>
      </div>`).join('');

    $('joinedHint').textContent = `共 ${list.length} 个谱，其中管理员 ${managed.length} 个。`;
    $('joinedList').innerHTML = list.length
      ? list.map(rowHtml).join('')
      : emptyHtml('还没有加入任何族谱，可返回族谱首页创建或申请加入。');
    $('managedList').innerHTML = managed.length
      ? managed.map(rowHtml).join('')
      : emptyHtml('当前没有管理的族谱。');
    $('identityList').innerHTML = identities.length
      ? identities.map(g => `
        <div class="me-row">
          <div class="me-row-main">
            <div class="me-row-title">${esc(g.name)}<span class="role-pill role-normal">${esc(g.kind === 'kinship' ? '亲戚谱' : '家谱')}</span></div>
            <div class="me-row-meta"><span>绑定身份：${esc(identityText(g))}</span></div>
          </div>
          <button class="btn ghost" data-enter="${g.id}">进入</button>
        </div>`).join('')
      : emptyHtml('尚未在任何族谱中绑定身份，可在小程序或族谱成员管理中完成绑定。');

    bindEnter($('joinedList'));
    bindEnter($('managedList'));
    bindEnter($('identityList'));
  }

  async function load() {
    try {
      render(await api('/api/auth/me'));
    } catch (err) {
      toast(err.message, true);
      $('profileSub').textContent = err.message;
    }
  }

  $('logoutBtn').addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch (e) { /* ignore */ }
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    localStorage.removeItem('genealogy_id');
    window.location.href = '/login';
  });

  load();
})();
