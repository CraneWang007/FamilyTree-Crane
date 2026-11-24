/* 家和万事兴 · 首页：族谱选择 / 创建 */
(function () {
  const $ = id => document.getElementById(id);
  const TOKEN = localStorage.getItem('token');

  if (!TOKEN) { window.location.href = '/login'; return; }

  const user = JSON.parse(localStorage.getItem('user') || '{}');
  $('userBadge').textContent = user.display_name || user.username || '用户';

  function toast(msg, isErr) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.toggle('error', !!isErr);
    t.classList.remove('hidden');
    requestAnimationFrame(() => t.classList.add('show'));
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.classList.add('hidden'), 220); }, 2400);
  }

  async function api(url, options) {
    const opts = Object.assign({}, options || {});
    opts.headers = Object.assign({ 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOKEN }, opts.headers || {});
    if (opts.body && typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { localStorage.removeItem('token'); localStorage.removeItem('user'); window.location.href = '/login'; throw new Error('登录已过期'); }
    if (!res.ok || data.ok === false) throw new Error(data.error || '请求失败');
    return data.data;
  }

  const ROLE_LABEL = { admin: '管理员', branch_admin: '分支管理员', normal: '成员' };
  const ROLE_CLASS = { admin: 'role-admin', branch_admin: 'role-branch', normal: 'role-normal' };

  async function loadList() {
    try {
      const list = await api('/api/genealogies');
      renderList(list);
    } catch (err) {
      toast(err.message, true);
      renderList([]);
    }
  }

  function renderList(list) {
    const grid = $('genealogyGrid');
    const empty = $('emptyBlock');
    if (!list || !list.length) {
      grid.innerHTML = '';
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');
    grid.innerHTML = list.map(g => `
      <div class="genealogy-card${g.kind === 'kinship' ? ' kinship' : ''}" data-id="${g.id}">
        <div class="gc-head">
          <div class="gc-name">${esc(g.name)}</div>
          ${g.kind === 'kinship' ? '<span class="role-pill role-kinship">亲戚谱</span>' : ''}
          ${g.is_default ? '<span class="role-pill role-default">默认指引</span>' : ''}
          <span class="role-pill ${ROLE_CLASS[g.role]}">${ROLE_LABEL[g.role] || g.role}</span>
        </div>
        <p class="gc-desc">${esc(g.description || '暂无简介')}</p>
        <div class="gc-meta">
          <span>成员 <b>${g.member_count || 0}</b> 人</span>
          <span>${g.kind === 'kinship' ? '仅本人与管理员可见' : (g.visibility === 'public' ? '公开谱' : '私密谱')}</span>
          <span>创建于 ${(g.created_at || '').slice(0, 10)}</span>
        </div>
        ${g.role === 'admin' && g.kind !== 'kinship' ? `<button class="btn ghost block gc-visibility" data-next="${g.visibility === 'public' ? 'private' : 'public'}">${g.visibility === 'public' ? '设为私密' : '设为公开'}</button>` : ''}
        <button class="btn primary block">进入${g.kind === 'kinship' ? '亲戚谱' : '族谱'}</button>
      </div>
    `).join('');
    grid.querySelectorAll('.genealogy-card').forEach(card => {
      card.addEventListener('click', () => {
        const id = Number(card.dataset.id);
        localStorage.setItem('genealogy_id', String(id));
        window.location.href = '/';
      });
    });
    grid.querySelectorAll('.gc-visibility').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        const id = Number(btn.closest('.genealogy-card').dataset.id);
        try {
          await api(`/api/genealogies/${id}/visibility`, { method: 'PUT', body: { visibility: btn.dataset.next } });
          toast(btn.dataset.next === 'public' ? '已设为公开谱' : '已设为私密谱');
          loadList();
          loadPublic();
        } catch (err) { toast(err.message, true); }
      });
    });
  }

  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // 新建弹窗
  function openCreate() {
    $('modalMask').classList.remove('hidden');
    $('f_name').value = '';
    $('f_description').value = '';
    setTimeout(() => $('f_name').focus(), 80);
  }
  function closeCreate() { $('modalMask').classList.add('hidden'); }

  $('newGenealogyBtn').addEventListener('click', openCreate);
  $('emptyCreateBtn').addEventListener('click', openCreate);
  $('modalClose').addEventListener('click', closeCreate);
  $('cancelCreate').addEventListener('click', closeCreate);
  $('modalMask').addEventListener('click', e => { if (e.target === $('modalMask')) closeCreate(); });

  $('confirmCreate').addEventListener('click', async () => {
    const name = $('f_name').value.trim();
    const description = $('f_description').value.trim();
    if (!name) { toast('请填写族谱名称', true); return; }
    try {
      const data = await api('/api/genealogies', { method: 'POST', body: { name, description } });
      closeCreate();
      toast(`已创建「${name}」`);
      localStorage.setItem('genealogy_id', String(data.id));
      setTimeout(() => { window.location.href = '/'; }, 600);
    } catch (err) { toast(err.message, true); }
  });

  $('logoutBtn').addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch (e) { /* ignore */ }
    localStorage.removeItem('token'); localStorage.removeItem('user'); localStorage.removeItem('genealogy_id');
    window.location.href = '/login';
  });

  // ------------------------------------------------------------------
  // 公开族谱：列表 / 只读树预览 / 申请加入绑定
  // ------------------------------------------------------------------
  let publicList = [];
  let currentPublic = null;

  async function loadPublic() {
    try {
      publicList = await api('/api/genealogies/public');
      renderPublic(publicList);
    } catch (err) { renderPublic([]); }
  }

  function renderPublic(list) {
    const grid = $('publicGrid');
    $('publicEmpty').classList.toggle('hidden', !!list.length);
    grid.innerHTML = list.map(g => {
      let action;
      if (g.is_member) action = '<button class="btn primary block">进入族谱</button>';
      else if (g.is_default) action = '<button class="btn primary block">进入查看</button>';
      else if (g.pending_join) action = '<button class="btn block" disabled>加入申请待审批</button>';
      else action = '<button class="btn primary block">查看并申请加入</button>';
      return `
      <div class="genealogy-card public" data-id="${g.id}">
        <div class="gc-head"><div class="gc-name">${esc(g.name)}</div>${g.is_default ? '<span class="role-pill role-default">默认指引</span>' : '<span class="role-pill role-normal">公开</span>'}</div>
        <p class="gc-desc">${esc(g.description || '暂无简介')}</p>
        <div class="gc-meta"><span>成员 <b>${g.member_count}</b> 人</span><span>${g.generation_count} 代</span>${g.is_default && !g.is_member ? '<span>免加入查看</span>' : ''}</div>
        ${action}
      </div>`;
    }).join('');
    grid.querySelectorAll('.genealogy-card').forEach(card => {
      card.addEventListener('click', () => {
        const g = publicList.find(x => x.id === Number(card.dataset.id));
        if (!g) return;
        if (g.is_member || g.is_default) {
          localStorage.setItem('genealogy_id', String(g.id));
          window.location.href = '/';
        } else {
          openPublicPreview(g);
        }
      });
    });
  }

  function flattenPublicNodes(root) {
    const out = [];
    (function walk(node) {
      out.push({ id: node.id, name: node.name, generation: node.generation });
      (node.spouses || []).forEach(sp => out.push({ id: sp.id, name: sp.name + '（配偶）', generation: sp.generation }));
      (node.children || []).forEach(walk);
    })(root);
    return out;
  }

  async function openPublicPreview(g) {
    currentPublic = g;
    $('publicModalTitle').textContent = g.name + ' · 公开预览';
    $('publicModalMask').classList.remove('hidden');
    $('publicTreeSvg').innerHTML = '';
    $('joinStatus').textContent = '加载中…';
    $('joinSubmit').disabled = true;
    try {
      const data = await api(`/api/genealogies/${g.id}/tree/lineage`);
      if (!data || !data.root) {
        $('joinStatus').textContent = '该族谱暂无成员';
        return;
      }
      const result = FamilyTree.renderLineage(data, {});
      const svg = $('publicTreeSvg');
      svg.innerHTML = result.inner;
      const b = result.bounds;
      svg.setAttribute('viewBox', `${b.x} ${b.y} ${b.w} ${b.h}`);
      const members = flattenPublicNodes(data.root);
      $('joinMemberSelect').innerHTML = members.map(m =>
        `<option value="${m.id}">第${m.generation}代 · ${esc(m.name)}</option>`).join('');
      if (g.pending_join) {
        $('joinStatus').textContent = '你已提交加入申请，等待管理员审批。';
        $('joinMemberSelect').disabled = true;
      } else {
        $('joinStatus').textContent = '';
        $('joinMemberSelect').disabled = false;
        $('joinSubmit').disabled = false;
      }
    } catch (err) {
      $('joinStatus').textContent = err.message;
    }
  }

  function closePublicPreview() { $('publicModalMask').classList.add('hidden'); currentPublic = null; }
  $('publicModalClose').addEventListener('click', closePublicPreview);
  $('publicCancel').addEventListener('click', closePublicPreview);
  $('publicModalMask').addEventListener('click', e => { if (e.target === $('publicModalMask')) closePublicPreview(); });

  $('joinSubmit').addEventListener('click', async () => {
    if (!currentPublic) return;
    const memberId = Number($('joinMemberSelect').value);
    if (!memberId) { toast('请选择要绑定的谱成员', true); return; }
    try {
      await api(`/api/genealogies/${currentPublic.id}/join`, { method: 'POST', body: { member_id: memberId } });
      toast('申请已提交，等待管理员审批');
      $('joinStatus').textContent = '你已提交加入申请，等待管理员审批。';
      $('joinSubmit').disabled = true;
      $('joinMemberSelect').disabled = true;
      loadPublic();
    } catch (err) { toast(err.message, true); }
  });

  // 绑定微信（已绑定则仅展示状态）
  function refreshWechatBtn() {
    $('wechatBindBtn').textContent = user.wechat_bound ? '微信已绑定' : '绑定微信';
  }
  refreshWechatBtn();
  $('wechatBindBtn').addEventListener('click', async () => {
    if (user.wechat_bound) { toast('当前账号已绑定微信'); return; }
    const code = window.prompt('请输入微信登录 code（小程序 wx.login 获取；开发环境可任意填写）');
    if (!code) return;
    try {
      await api('/api/auth/wechat/bind', { method: 'POST', body: { code } });
      user.wechat_bound = true;
      localStorage.setItem('user', JSON.stringify(user));
      refreshWechatBtn();
      toast('微信绑定成功');
    } catch (err) { toast(err.message, true); }
  });

  loadList();
  loadPublic();
})();
