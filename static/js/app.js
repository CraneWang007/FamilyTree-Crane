/* 家和万事兴 · 前端交互（多谱 / 多用户 / 权限） */
(function () {
  const TOKEN = localStorage.getItem('token');
  const GID = Number(localStorage.getItem('genealogy_id'));

  if (!TOKEN) { window.location.href = '/login'; return; }
  if (!GID) { window.location.href = '/home'; return; }

  const API_BASE = `/api/genealogies/${GID}`;
  const ZODIAC = ['鼠', '牛', '虎', '兔', '龙', '蛇', '马', '羊', '猴', '鸡', '狗', '猪'];

  const state = {
    view: 'lineage',
    members: [],
    stats: null,
    relationData: [],
    formSpouses: [],
    lineageRootId: null,
    lineageMax: 30,
    kinshipFocusId: null,
    search: '',
    detail: null,
    editId: null,
    bounds: null,
    pan: { x: 0, y: 0, k: 1 },
    moved: false,
    role: 'normal',
    kind: 'family',
    branch: 'father',
    branchAll: false,
    myMemberId: null,
    myKinshipId: null,
    genealogy: null,
    users: [],
    proposals: [],
  };

  const $ = id => document.getElementById(id);
  const els = {
    tabs: $('tabs'),
    btnAdd: $('btnAdd'),
    searchInput: $('searchInput'),
    searchCount: $('searchCount'),
    memberList: $('memberList'),
    statsBar: $('statsBar'),
    lineageToolbar: $('lineageToolbar'),
    lineageRoot: $('lineageRoot'),
    lineageMax: $('lineageMax'),
    lineageRefresh: $('lineageRefresh'),
    lineageHint: $('lineageHint'),
    branchToolbar: $('branchToolbar'),
    branchSwitch: $('branchSwitch'),
    branchGrid: $('branchGrid'),
    branchHint: $('branchHint'),
    kinshipToolbar: $('kinshipToolbar'),
    kinshipFocus: $('kinshipFocus'),
    kinshipRefresh: $('kinshipRefresh'),
    kinshipHint: $('kinshipHint'),
    canvasWrap: $('canvasWrap'),
    treeSvg: $('treeSvg'),
    canvasMsg: $('canvasMsg'),
    relationsPanel: $('relationsPanel'),
    relationBody: $('relationBody'),
    relationsMeta: $('relationsMeta'),
    membersPanel: $('membersPanel'),
    membersBody: $('membersBody'),
    permissionsPanel: $('permissionsPanel'),
    usersBody: $('usersBody'),
    transferTarget: $('transferTarget'),
    proposalsPanel: $('proposalsPanel'),
    proposalList: $('proposalList'),
    proposalMeta: $('proposalMeta'),
    proposalDot: $('proposalDot'),
    modalMask: $('modalMask'),
    modalTitle: $('modalTitle'),
    modalSub: $('modalSub'),
    modalClose: $('modalClose'),
    photoFrame: $('photoFrame'),
    uploadLabel: $('uploadLabel'),
    photoInput: $('photoInput'),
    detailView: $('detailView'),
    memberForm: $('memberForm'),
    modalFoot: $('modalFoot'),
    userModalMask: $('userModalMask'),
    ioModalMask: $('ioModalMask'),
    toast: $('toast'),
    genealogyLabel: $('genealogyLabel'),
    rolePill: $('rolePill'),
    userBtn: $('userBtn'),
    userDropdown: $('userDropdown'),
  };

  /* ---------- 工具 ---------- */
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
  }

  function toast(message, isError) {
    els.toast.textContent = message;
    els.toast.classList.toggle('error', !!isError);
    els.toast.classList.remove('hidden');
    requestAnimationFrame(() => els.toast.classList.add('show'));
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => {
      els.toast.classList.remove('show');
      setTimeout(() => els.toast.classList.add('hidden'), 220);
    }, isError ? 4200 : 2200);
  }

  async function api(url, options) {
    const opts = Object.assign({}, options || {});
    opts.headers = Object.assign({ 'Authorization': 'Bearer ' + TOKEN }, opts.headers || {});
    if (opts.body && typeof opts.body !== 'string' && !(opts.body instanceof FormData)) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    const res = await fetch(url, opts);
    let data = null;
    try { data = await res.json(); } catch (err) { /* ignore */ }
    if (res.status === 401) {
      localStorage.removeItem('token'); localStorage.removeItem('user');
      localStorage.removeItem('genealogy_id');
      window.location.href = '/login';
      throw new Error('登录已过期');
    }
    if (!res.ok || (data && data.ok === false)) {
      throw new Error((data && data.error) || `请求失败（${res.status}）`);
    }
    return data ? data.data : null;
  }

  function isAdmin() { return state.role === 'admin'; }
  function isBranchOrAdmin() { return state.role === 'admin' || state.role === 'branch_admin'; }

  const ROLE_LABEL = { admin: '管理员', branch_admin: '分支管理员', normal: '成员' };
  const ROLE_CLASS = { admin: 'role-admin', branch_admin: 'role-branch', normal: 'role-normal' };

  /* ---------- 数据加载 ---------- */
  async function loadBootstrap() {
    const [gen, stats] = await Promise.all([
      api(`${API_BASE}`),
      api(`${API_BASE}/stats`),
    ]);
    state.genealogy = gen;
    state.role = gen.role;
    state.kind = gen.kind || 'family';
    state.myMemberId = gen.my_member_id || null;
    state.stats = stats;
    const roleLabel = ROLE_LABEL[gen.role] || '访客';
    els.genealogyLabel.textContent = `${gen.name} · ${roleLabel}`;
    els.rolePill.textContent = roleLabel;
    els.rolePill.className = 'role-pill ' + (ROLE_CLASS[gen.role] || 'role-normal');
    els.rolePill.classList.remove('hidden');
    // 默认指引谱的访客：只读查看，隐藏权限管理与审批入口
    if (!gen.role) {
      ['permissions', 'proposals'].forEach(viewName => {
        const tab = els.tabs.querySelector(`.tab[data-view="${viewName}"]`);
        if (tab) tab.classList.add('hidden');
      });
    }
    // 亲戚谱：隐藏「动态亲戚谱」视图标签（亲戚谱本身就是独立族谱数据）
    const isKin = state.kind === 'kinship';
    const kinTab = els.tabs.querySelector('.tab[data-view="kinship"]');
    if (kinTab) kinTab.classList.toggle('hidden', isKin);
    // 亲戚谱的协作者由源谱管理员自动同步，不提供权限管理入口
    const permTab = els.tabs.querySelector('.tab[data-view="permissions"]');
    if (permTab) permTab.classList.toggle('hidden', isKin);
    // 亲戚谱内不再出现「家谱」字样，避免与源家谱混淆
    const lineageTab = els.tabs.querySelector('.tab[data-view="lineage"]');
    if (lineageTab) lineageTab.textContent = isKin ? '亲戚谱' : '家谱';
    document.title = isKin ? '家和万事兴 · 亲戚谱' : '家和万事兴 · 家谱与亲戚谱';
    const relationsNote = $('relationsNote');
    if (relationsNote) {
      relationsNote.textContent = isKin
        ? '人员信息表由亲戚谱独立保存；关系表记录每人的关系类型、父节点、母节点与配偶数组。'
        : '人员信息表为家谱与亲戚谱共用；关系表记录每人的关系类型、父节点、母节点与配偶数组。';
    }
    if (isKin && (state.view === 'kinship' || state.view === 'permissions')) {
      state.view = 'lineage';
      Array.from(els.tabs.querySelectorAll('.tab')).forEach(tab => {
        tab.classList.toggle('active', tab.dataset.view === 'lineage');
      });
    }
    // 权限控制：非写权限隐藏新增按钮
    els.btnAdd.style.display = isBranchOrAdmin() ? '' : 'none';
    // 首次进入时同步工具栏：亲戚谱显示三支切换，家谱显示线谱工具
    applyViewChrome(state.view);
  }

  async function loadMembers() {
    state.members = await api(`${API_BASE}/members`);
    // 从家谱成员详情跳转而来：定位到亲戚谱中的对应成员
    const focusSource = Number(sessionStorage.getItem('kinship_focus_source_id') || 0);
    if (focusSource) {
      sessionStorage.removeItem('kinship_focus_source_id');
      const matched = state.members.find(m => Number(m.source_member_id) === focusSource);
      if (matched) state.lineageRootId = matched.member_id;
    }
    if (state.lineageRootId == null || !memberById(state.lineageRootId)) {
      state.lineageRootId = defaultLineageRoot();
    }
    if (state.kinshipFocusId == null || !memberById(state.kinshipFocusId)) {
      state.kinshipFocusId = defaultKinshipFocus();
    }
    fillSelects();
    renderDirectory();
    renderStats();
    renderMembersTable();
  }

  function memberById(id) { return state.members.find(m => m.member_id === Number(id)) || null; }

  function yearText(birth, death) {
    if (birth && death) return `${birth}—${death}`;
    if (birth) return `生于 ${birth}`;
    if (death) return `卒于 ${death}`;
    return '未录入';
  }

  function generationText(gen) { return gen ? `第 ${gen} 代` : '未定代'; }

  function sortMembers(list) {
    return list.slice().sort((a, b) => {
      if (a.generation !== b.generation) return a.generation - b.generation;
      const ar = a.sibling_rank == null ? 999 : a.sibling_rank;
      const br = b.sibling_rank == null ? 999 : b.sibling_rank;
      if (ar !== br) return ar - br;
      const ay = a.birth_year == null ? 9999 : a.birth_year;
      const by = b.birth_year == null ? 9999 : b.birth_year;
      return ay - by;
    });
  }

  function matchesSearch(m, q) {
    if (!q) return false;
    const hay = [m.name, m.code, m.hometown, m.residence, m.contact, m.zodiac, String(m.generation)]
      .join(' ').toLowerCase();
    return hay.includes(q);
  }

  function defaultLineageRoot() {
    const candidates = state.members.filter(m => !m.father_id && !m.mother_id && m.relation_type !== '配偶');
    const pool = candidates.length ? candidates : state.members;
    const sorted = sortMembers(pool);
    return sorted.length ? sorted[0].member_id : null;
  }

  function defaultKinshipFocus() {
    if (!state.members.length) return null;
    const pool = state.members.filter(m => (m.children_count || 0) > 0 && (m.father_id || m.mother_id));
    const usable = pool.length ? pool : state.members;
    const sorted = usable.slice().sort((a, b) => {
      if ((b.children_count || 0) !== (a.children_count || 0)) return (b.children_count || 0) - (a.children_count || 0);
      return b.generation - a.generation;
    });
    return sorted[0].member_id;
  }

  function optionsForMembers(list, selectedId, includeEmpty) {
    const parts = includeEmpty ? ['<option value="">未录入</option>'] : [];
    list.forEach(m => {
      parts.push(`<option value="${m.member_id}"${m.member_id === selectedId ? ' selected' : ''}>` +
        `${generationText(m.generation)} · ${esc(m.name)}（${esc(m.code)}）</option>`);
    });
    return parts.join('');
  }

  function fillSelects() {
    els.lineageRoot.innerHTML = optionsForMembers(sortMembers(state.members), state.lineageRootId, false);
    els.kinshipFocus.innerHTML = optionsForMembers(sortMembers(state.members), state.kinshipFocusId, false);
    if (state.lineageRootId != null) els.lineageRoot.value = String(state.lineageRootId);
    if (state.kinshipFocusId != null) els.kinshipFocus.value = String(state.kinshipFocusId);
    els.lineageMax.value = String(state.lineageMax);
  }

  function renderStats() {
    const s = state.stats;
    if (!s) { els.statsBar.innerHTML = ''; return; }
    els.statsBar.innerHTML = `
      <span>成员 <b>${s.members}</b> 人</span>
      <span>已录 <b>${s.max_generation}</b> 代</span>
      <span>男 <b>${s.male}</b> · 女 <b>${s.female}</b></span>
      <span>宗谱上限 <b>${s.max_generations}</b> 代</span>`;
  }

  function renderDirectory() {
    const q = state.search.trim().toLowerCase();
    const list = sortMembers(state.members).filter(m => (q ? matchesSearch(m, q) : true));
    els.searchCount.textContent = q ? `${list.length} / ${state.members.length}` : '';

    if (!list.length) {
      els.memberList.innerHTML = `<div class="gen-divider">未找到匹配成员</div>`;
      return;
    }

    let html = '';
    let currentGen = null;
    list.forEach(m => {
      if (m.generation !== currentGen) {
        currentGen = m.generation;
        const count = list.filter(x => x.generation === currentGen).length;
        html += `<div class="gen-divider">第 ${currentGen} 代 · ${count} 人</div>`;
      }
      const active = (state.view === 'lineage' && m.member_id === state.lineageRootId)
        || (state.view === 'kinship' && m.member_id === state.kinshipFocusId);
      const initial = m.name ? m.name.slice(0, 1) : '·';
      const avatar = m.photo
        ? `<div class="avatar ${m.gender === '女' ? 'female' : 'male'}"><img src="${esc(m.photo)}" alt=""></div>`
        : `<div class="avatar ${m.gender === '女' ? 'female' : 'male'}">${esc(initial)}</div>`;
      const meta = [m.sibling_rank ? `行${m.sibling_rank}` : '', yearText(m.birth_year, m.death_year)]
        .filter(Boolean).join(' · ');
      html += `<div class="member-item${active ? ' is-current' : ''}" data-person="${m.member_id}">
        ${avatar}
        <div class="member-lines">
          <div class="member-name">${esc(m.name)}
            ${m.relation_type === '配偶' ? '<span class="spouse-mark">配</span>' : ''}
            ${m.relation_type === '收养' ? '<span class="spouse-mark">养</span>' : ''}
            ${m.relation_type === '过继' ? '<span class="spouse-mark">继</span>' : ''}
          </div>
          <div class="member-meta">${esc(meta || generationText(m.generation))}</div>
        </div>
      </div>`;
    });
    els.memberList.innerHTML = html;
  }

  /* ---------- 成员管理表格 ---------- */
  function renderMembersTable() {
    const q = state.search.trim().toLowerCase();
    let rows = state.members;
    if (q) rows = rows.filter(m => matchesSearch(m, q));
    if (!rows.length) {
      els.membersBody.innerHTML = '<tr><td colspan="11" class="none">暂无成员</td></tr>';
      return;
    }
    const canDelete = isAdmin();
    els.membersBody.innerHTML = rows.map(m => `
      <tr data-person="${m.member_id}">
        <td>${esc(m.code)}</td>
        <td>${esc(m.name)}</td>
        <td>${m.gender}</td>
        <td>${generationText(m.generation)}</td>
        <td>${m.sibling_rank || '—'}</td>
        <td>${esc(yearText(m.birth_year, m.death_year))}</td>
        <td>${esc(m.zodiac || '—')}</td>
        <td>${esc(m.hometown || '—')}</td>
        <td>${esc(m.residence || '—')}</td>
        <td><span class="type-pill ${esc(m.relation_type)}">${esc(m.relation_type)}</span></td>
        <td class="row-actions">
          <button class="link-btn" data-act="view">查看</button>
          ${m.can_edit ? '<button class="link-btn" data-act="edit">编辑</button>' : ''}
          ${canDelete ? '<button class="link-btn danger" data-act="delete">删除</button>' : ''}
        </td>
      </tr>
    `).join('');
  }

  /* ---------- 家谱 / 亲戚谱 ---------- */
  function showCanvasMessage(title, message) {
    els.canvasMsg.innerHTML = `<div class="msg-card"><h3>${esc(title)}</h3><p>${esc(message)}</p></div>`;
    els.canvasMsg.classList.remove('hidden');
  }
  function hideCanvasMessage() {
    els.canvasMsg.classList.add('hidden');
    els.canvasMsg.innerHTML = '';
  }

  function currentHighlightIds() {
    const q = state.search.trim().toLowerCase();
    if (!q) return null;
    const ids = new Set();
    state.members.forEach(m => { if (matchesSearch(m, q)) ids.add(m.member_id); });
    return ids;
  }

  function applyTree(data, renderer) {
    if (!data) {
      els.treeSvg.innerHTML = '';
      state.bounds = null;
      showCanvasMessage('尚无成员', '点击右上角「新增成员」，先录入家族中的第一位成员。');
      return;
    }
    const result = renderer(data, { highlightIds: currentHighlightIds(), myId: state.myMemberId });
    els.treeSvg.innerHTML = `<g id="viewport">${result.inner}</g>`;
    state.bounds = result.bounds;
    hideCanvasMessage();
    fitToBounds();
    applySearchHighlight();
  }

  const BRANCH_LABEL = {
    father: '父系亲戚', mother: '母系亲戚',
    spouse: '配偶父系', spouse_father: '配偶父系', spouse_mother: '配偶母系',
  };

  function setBranchLayout(all) {
    els.branchGrid.classList.toggle('hidden', !all);
    els.treeSvg.classList.toggle('hidden', all);
    const zoomBar = document.querySelector('.zoom-bar');
    if (zoomBar) zoomBar.classList.toggle('hidden', all);
    if (all) els.canvasMsg.classList.add('hidden');
  }

  function renderBranchGrid(list) {
    setBranchLayout(true);
    els.branchHint.textContent = '父系 7 级 · 母系 5 级 · 配偶父系/母系 5 级';
    els.branchGrid.innerHTML = list.map(data => {
      const label = BRANCH_LABEL[data.branch] || '';
      if (!data || !data.root) {
        return `<section class="branch-block"><h4>${label} · 0 人</h4>` +
          `<div class="branch-empty">暂无可展示的亲属节点</div></section>`;
      }
      const result = FamilyTree.renderLineage(data, {
        highlightIds: currentHighlightIds(),
        myId: state.myMemberId,
      });
      const b = result.bounds;
      return `<section class="branch-block"><h4>${label} · 共 ${data.total} 人 · ${data.generations} 级</h4>` +
        `<div class="branch-canvas"><svg class="tree-svg" viewBox="${b.x} ${b.y} ${b.w} ${b.h}" ` +
        `preserveAspectRatio="xMidYMin meet"><g>${result.inner}</g></svg></div></section>`;
    }).join('');
  }

  async function loadBranches() {
    if (!state.members.length) { setBranchLayout(false); applyTree(null, null); return; }
    const branches = state.branchAll ? ['father', 'mother', 'spouse_father', 'spouse_mother'] : [state.branch];
    try {
      const list = await Promise.all(branches.map(b =>
        api(`${API_BASE}/tree/lineage?branch=${b}`)));
      if (state.branchAll) { renderBranchGrid(list); return; }
      setBranchLayout(false);
      const data = list[0];
      if (!data || !data.root) {
        els.treeSvg.innerHTML = '';
        state.bounds = null;
        showCanvasMessage(`暂无${BRANCH_LABEL[state.branch]}`, '该分支尚无可展示的亲属节点。');
        els.branchHint.textContent = `${BRANCH_LABEL[state.branch]} · 0 人`;
        return;
      }
      applyTree(data, FamilyTree.renderLineage);
      els.branchHint.textContent = `${BRANCH_LABEL[state.branch]} · 共 ${data.total} 人 · ${data.generations} 级`;
    } catch (err) { toast(err.message, true); }
  }

  async function loadLineage() {
    if (state.kind === 'kinship') { loadBranches(); return; }
    setBranchLayout(false);
    if (!state.members.length) { applyTree(null, null); return; }
    try {
      const data = await api(`${API_BASE}/tree/lineage?root_id=${state.lineageRootId}&max_generations=${state.lineageMax}`);
      if (!data) { applyTree(null, null); return; }
      state.lineageRootId = data.root_id;
      els.lineageRoot.value = String(data.root_id);
      applyTree(data, FamilyTree.renderLineage);
      els.lineageHint.textContent = `${data.root.name}系 · 共 ${data.total} 人 · 已展 ${data.depth + 1} 代（上限 ${data.generation_limit} 代）`;
    } catch (err) { toast(err.message, true); }
  }

  async function loadKinship() {
    if (!state.members.length) { setBranchLayout(false); applyTree(null, null); return; }
    const focus = memberById(state.kinshipFocusId) || memberById(defaultKinshipFocus());
    state.kinshipFocusId = focus ? focus.member_id : null;
    if (!focus) { setBranchLayout(false); applyTree(null, null); return; }
    try {
      const list = await Promise.all(['father', 'mother', 'spouse_father', 'spouse_mother'].map(b =>
        api(`${API_BASE}/tree/lineage?branch=${b}&center_id=${state.kinshipFocusId}`)));
      renderBranchGrid(list);
      els.kinshipHint.textContent =
        `中心：${focus.name} · 父系 7 级 · 母系 5 级 · 配偶父系/母系 5 级 · 四支同屏`;
    } catch (err) {
      setBranchLayout(false);
      els.treeSvg.innerHTML = '';
      state.bounds = null;
      showCanvasMessage('无法生成亲戚谱', err.message);
      els.kinshipHint.textContent = '父系 7 级 · 母系 5 级 · 配偶父系/母系 5 级 · 四支同屏';
      toast(err.message, true);
    }
  }

  async function loadRelations() {
    try {
      state.relationData = await api(`${API_BASE}/relations`);
      renderRelationTable();
    } catch (err) {
      els.relationBody.innerHTML = `<tr><td colspan="10" class="none">${esc(err.message)}</td></tr>`;
    }
  }

  function renderRelationTable() {
    const q = state.search.trim().toLowerCase();
    let rows = state.relationData;
    if (q) {
      rows = rows.filter(r => {
        const spouses = (r.spouses || []).map(s => s.name).join(' ');
        return [r.name, r.code, r.father_name, r.mother_name, r.relation_type, spouses, r.generation]
          .join(' ').toLowerCase().includes(q);
      });
    }
    els.relationsMeta.textContent = `共 ${rows.length} 条关系记录 · 人员 ${state.members.length} 人`;
    if (!rows.length) {
      els.relationBody.innerHTML = '<tr><td colspan="10" class="none">没有匹配的关系记录</td></tr>';
      return;
    }
    els.relationBody.innerHTML = rows.map(r => {
      const father = r.father_name ? esc(r.father_name) : '<span class="none">未录入</span>';
      const mother = r.mother_name ? esc(r.mother_name) : '<span class="none">未录入</span>';
      const spouse = (r.spouses && r.spouses.length)
        ? r.spouses.map(s => esc(s.name)).join('、')
        : '<span class="none">无</span>';
      return `<tr data-person="${r.member_id}">
        <td>${r.relation_id}</td>
        <td>${esc(r.code)}</td>
        <td>${esc(r.name)}</td>
        <td><span class="type-pill ${esc(r.relation_type)}">${esc(r.relation_type)}</span></td>
        <td>${father}</td>
        <td>${mother}</td>
        <td class="spouse-list">${spouse}</td>
        <td>${generationText(r.generation)}</td>
        <td>${r.sibling_rank ? `行${r.sibling_rank}` : '<span class="none">—</span>'}</td>
        <td class="row-actions">
          <button class="link-btn" data-act="view">查看</button>
          ${r.can_edit ? '<button class="link-btn" data-act="edit">编辑</button>' : ''}
        </td>
      </tr>`;
    }).join('');
  }

  function reloadTree() {
    if (state.view === 'lineage') return loadLineage();
    if (state.view === 'kinship') return loadKinship();
    return Promise.resolve();
  }

  function applySearchHighlight() {
    const ids = currentHighlightIds();
    els.treeSvg.querySelectorAll('g.node').forEach(node => {
      const id = Number(node.dataset.id);
      node.classList.toggle('is-match', !!ids && ids.has(id));
    });
  }

  function fitToBounds() {
    if (!state.bounds) return;
    const rect = els.canvasWrap.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const b = state.bounds;
    const pad = 52;
    let k = Math.min((rect.width - pad * 2) / b.w, (rect.height - pad * 2) / b.h);
    k = Math.max(0.2, Math.min(k, 1.18));
    state.pan.k = k;
    state.pan.x = (rect.width - b.w * k) / 2 - b.x * k;
    state.pan.y = (rect.height - b.h * k) / 2 - b.y * k;
    applyTransform();
  }

  function applyTransform() {
    const viewport = els.treeSvg.querySelector('#viewport');
    if (!viewport) return;
    viewport.setAttribute('transform', `translate(${state.pan.x} ${state.pan.y}) scale(${state.pan.k})`);
  }

  function zoomBy(factor, px, py) {
    const rect = els.treeSvg.getBoundingClientRect();
    const cx = px == null ? rect.width / 2 : px;
    const cy = py == null ? rect.height / 2 : py;
    const next = Math.max(0.15, Math.min(2.4, state.pan.k * factor));
    const wx = (cx - state.pan.x) / state.pan.k;
    const wy = (cy - state.pan.y) / state.pan.k;
    state.pan.k = next;
    state.pan.x = cx - wx * next;
    state.pan.y = cy - wy * next;
    applyTransform();
  }

  /* ---------- 弹窗 ---------- */
  function openModal() {
    els.modalMask.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }
  function closeModal() {
    els.modalMask.classList.add('hidden');
    document.body.style.overflow = '';
    state.detail = null;
    state.editId = null;
    els.photoInput.value = '';
    els.memberForm.innerHTML = '';
    els.detailView.innerHTML = '';
  }

  function renderPhoto(photo, name) {
    if (photo) {
      els.photoFrame.innerHTML = `<img src="${esc(photo)}" alt="${esc(name)}">`;
    } else {
      els.photoFrame.innerHTML = `<span class="photo-initial">${esc(name ? name.slice(0, 1) : '·')}</span>`;
    }
  }

  async function openDetail(memberId) {
    try {
      const data = await api(`${API_BASE}/members/${memberId}`);
      state.detail = data;
      state.editId = null;
      els.modalTitle.textContent = data.name;
      els.modalSub.textContent = `${data.code} · ${generationText(data.generation)} · 关系表第 ${data.relation_id || '—'} 行`;
      renderPhoto(data.photo, data.name);
      els.uploadLabel.classList.toggle('hidden', !data.can_edit);
      renderDetailView(data);
      els.memberForm.classList.add('hidden');
      els.detailView.classList.remove('hidden');
      renderDetailFoot(data);
      openModal();
      markDirectoryCurrent(data.member_id);
    } catch (err) { toast(err.message, true); }
  }

  function markDirectoryCurrent(id) {
    els.memberList.querySelectorAll('.member-item').forEach(item => {
      item.classList.toggle('is-current', Number(item.dataset.person) === id);
    });
  }

  function personChip(member) {
    if (!member) return '<span class="none">未录入</span>';
    return `<span class="person-chip" data-person="${member.id}">${esc(member.name)}<span class="none">·${member.generation}代</span></span>`;
  }

  function renderDetailView(m) {
    const tags = [
      `<span class="tag ${m.gender === '女' ? 'rose' : 'jade'}">${esc(m.gender)}</span>`,
      `<span class="tag">${generationText(m.generation)}</span>`,
      m.sibling_rank ? `<span class="tag">兄弟排行 ${m.sibling_rank}</span>` : '',
      `<span class="tag ${m.relation_type === '配偶' ? 'rose' : ''}">${esc(m.relation_type)}</span>`,
    ].filter(Boolean).join('');

    const info = [
      ['唯一编码', esc(m.code) || '<span class="none">未录入</span>'],
      ['生卒年', esc(yearText(m.birth_year, m.death_year))],
      ['生日', esc(m.birthday_text) || '<span class="none">未录入</span>'],
      ['属相', esc(m.zodiac) || '<span class="none">未录入</span>'],
      ['籍贯', esc(m.hometown) || '<span class="none">未录入</span>'],
      ['居住地', esc(m.residence) || '<span class="none">未录入</span>'],
      ['联系方式', esc(m.contact) || '<span class="none">未录入</span>'],
      ['代际 / 排行', `${generationText(m.generation)} / ${m.sibling_rank ? '行 ' + m.sibling_rank : '未录'}`],
    ].map(([k, v]) => `<div class="info-item"><label>${k}</label><div class="value">${v}</div></div>`).join('');

    const spouses = (m.spouses || []).length ? m.spouses.map(s => personChip(s)).join('') : '<span class="none">无记录</span>';
    const children = (m.children || []).length ? m.children.map(c => personChip(c)).join('') : '<span class="none">暂无子女</span>';

    els.detailView.innerHTML = `
      <div class="detail-hero">
        <span class="detail-name">${esc(m.name)}</span>
        <div class="detail-tags">${tags}</div>
      </div>
      <div class="info-grid">${info}</div>
      <div class="relation-box">
        <h3>关系表连接</h3>
        <div class="relation-line"><span class="k">位置</span>
          关系表 relation_id = ${m.relation_id || '—'} · 类型
          <span class="type-pill ${esc(m.relation_type)}">${esc(m.relation_type)}</span>
          · spouse_array ${(m.spouse_ids || []).length} 项
        </div>
        <div class="relation-line"><span class="k">父亲</span>${personChip(m.father)}</div>
        <div class="relation-line"><span class="k">母亲</span>${personChip(m.mother)}</div>
        <div class="relation-line"><span class="k">配偶</span>${spouses}</div>
        <div class="relation-line"><span class="k">子女</span>${children}</div>
      </div>`;
  }

  function renderDetailFoot(m) {
    const canEdit = !!m.can_edit;
    const isKinship = state.kind === 'kinship';
    const canManage = !!state.role; // 访客（默认谱免加入查看）只读
    els.modalFoot.innerHTML = [
      canEdit ? '<button class="btn primary" data-action="edit">编辑资料</button>' : '',
      isKinship || !canManage ? '' : '<button class="btn" data-action="set-root">设为家谱始祖</button>',
      isKinship || !canManage ? '' : '<button class="btn" data-action="kin-father">父系亲戚谱</button>',
      isKinship || !canManage ? '' : '<button class="btn" data-action="kin-mother">母系亲戚谱</button>',
      '<span class="spacer"></span>',
      isAdmin() ? '<button class="btn danger" data-action="delete">删除</button>' : '',
      '<button class="btn ghost" data-action="close">关闭</button>',
    ].join('');
  }

  function fieldHtml(label, name, value, options) {
    const opt = options || {};
    if (opt.type === 'select') {
      return `<div class="field${opt.full ? ' full' : ''}"><label>${label}</label>
        <select id="f_${name}">${opt.options}</select>${opt.hint ? `<span class="hint">${opt.hint}</span>` : ''}</div>`;
    }
    return `<div class="field${opt.full ? ' full' : ''}"><label>${label}${opt.required ? '<b>*</b>' : ''}</label>
      <input id="f_${name}" type="${opt.type || 'text'}" value="${esc(value == null ? '' : value)}"
        placeholder="${esc(opt.placeholder || '')}" ${opt.step ? `step="${opt.step}"` : ''}>${opt.hint ? `<span class="hint">${opt.hint}</span>` : ''}</div>`;
  }

  function buildForm(m) {
    const selfId = m ? m.member_id : null;
    const others = sortMembers(state.members.filter(x => x.member_id !== selfId));
    const parentOptions = optionsForMembers(others, null, true);

    // 配偶只回填「已经关联」的项，不把全员列表塞进选择框
    state.formSpouses = m
      ? (m.spouse_ids || []).map(id => {
        const sp = (m.spouses || []).find(s => Number(s.id) === Number(id)) || {};
        const mem = memberById(id) || {};
        return { id: Number(id), name: sp.name || mem.name || `#${id}` };
      })
      : [];

    els.memberForm.innerHTML = `<div class="form-grid">
      ${fieldHtml('姓名', 'name', m ? m.name : '', { required: true, placeholder: '如：陈广德' })}
      ${fieldHtml('唯一编码', 'code', m ? m.code : '', { placeholder: '留空自动生成，如 M00001' })}
      ${fieldHtml('性别', 'gender', m ? m.gender : '男', {
        type: 'select',
        options: `<option value="男"${m && m.gender === '男' ? ' selected' : ''}>男</option>
                  <option value="女"${m && m.gender === '女' ? ' selected' : ''}>女</option>`,
      })}
      <div class="field"><label>生卒年</label>
        <div style="display:flex;gap:8px;align-items:center">
          <input id="f_birth_year" type="number" min="1000" max="2100" placeholder="出生年"
            value="${esc(m && m.birth_year ? m.birth_year : '')}">
          <span class="none">—</span>
          <input id="f_death_year" type="number" min="1000" max="2100" placeholder="去世年"
            value="${esc(m && m.death_year ? m.death_year : '')}">
        </div>
      </div>
      <div class="field full"><label>生日（可留空）</label>
        <div class="birthday-row">
          <input id="f_birthday" type="date" value="${esc(m && m.birthday ? m.birthday : '')}">
          <label class="check-inline"><input id="f_birthday_type" type="checkbox"${m && m.birthday_type === 'lunar' ? ' checked' : ''}> 农历（不勾选为阳历）</label>
        </div>
        <span class="hint" id="birthdayHint">${m && m.birthday_text ? esc(m.birthday_text) : '留空表示不记录生日'}</span>
      </div>
      ${fieldHtml('属相', 'zodiac', m ? m.zodiac : '', {
        type: 'select',
        options: `<option value="">（未录入）</option>` + ZODIAC.map(z =>
          `<option value="${z}"${m && m.zodiac === z ? ' selected' : ''}>${z}</option>`).join(''),
      })}
      ${fieldHtml('籍贯', 'hometown', m ? m.hometown : '', { placeholder: '如：山东省蓬莱县' })}
      ${fieldHtml('居住地', 'residence', m ? m.residence : '', { placeholder: '如：济南市历下区' })}
      ${fieldHtml('联系方式', 'contact', m ? m.contact : '', { placeholder: '电话 / 微信 / 邮箱' })}
      ${fieldHtml('兄弟间排行', 'sibling_rank', m ? m.sibling_rank : '', {
        type: 'number', placeholder: '留空自动排在同辈之后',
      })}
      ${fieldHtml('所属代际', 'generation', m ? m.generation : '', {
        type: 'number', placeholder: '1 — 30', hint: '选择父节点后自动为父节点代际 + 1',
      })}
      ${fieldHtml('关系类型', 'relation_type', m ? m.relation_type : '血缘', {
        type: 'select',
        options: ['血缘', '配偶', '收养', '过继'].map(t =>
          `<option value="${t}"${m && m.relation_type === t ? ' selected' : ''}>${t}</option>`).join(''),
      })}
      ${fieldHtml('父亲节点', 'father_id', m && m.father_id ? m.father_id : '', {
        type: 'select', options: parentOptions,
      })}
      ${fieldHtml('母亲节点', 'mother_id', m && m.mother_id ? m.mother_id : '', {
        type: 'select', options: parentOptions,
      })}
      ${fieldHtml('照片地址', 'photo', m ? m.photo : '', {
        full: true, placeholder: '可粘贴图片 URL，或在保存后上传本地照片',
      })}
      <div class="field full"><label>配偶（spouse_array）</label>
        <div class="spouse-tags" id="spouseTags"></div>
        <div class="spouse-picker">
          <select id="f_spouse_pick"></select>
          <button type="button" class="btn" id="btnSpouseAdd">＋ 添加配偶</button>
        </div>
        <span class="hint">只显示已关联的配偶，点「×」即可解除；保存后同步写入双方关系表的 spouse_array。
          长辈与晚辈不能设为配偶。</span>
      </div>
      <div class="form-note">
        ${state.kind === 'kinship'
          ? '人员信息表由亲戚谱独立保存；保存时会同步更新关系表中的 father_id、mother_id、relation_type 与 spouse_array。亲戚谱最多 30 代。'
          : '人员信息表由家谱与亲戚谱共用；保存时会同步更新关系表中的 father_id、mother_id、relation_type 与 spouse_array。家谱最多 30 代，亲戚谱仅支持 5 级以内查询。'}
      </div>
    </div>`;

    if (m) {
      els.memberForm.querySelector('#f_father_id').value = m.father_id ? String(m.father_id) : '';
      els.memberForm.querySelector('#f_mother_id').value = m.mother_id ? String(m.mother_id) : '';
    }
    renderSpouseEditor();

    // 生日：勾选农历 / 阳历切换时实时换算并提示
    const bdInput = els.memberForm.querySelector('#f_birthday');
    const bdType = els.memberForm.querySelector('#f_birthday_type');
    const bdHint = els.memberForm.querySelector('#birthdayHint');
    const refreshBirthday = async () => {
      if (!bdInput || !bdHint) return;
      if (!bdInput.value) {
        bdHint.textContent = '留空表示不记录生日';
        return;
      }
      try {
        const data = await api(`/api/calendar/convert?date=${bdInput.value}&type=${bdType.checked ? 'lunar' : 'solar'}`);
        bdHint.textContent = data.birthday_text;
        // 选择生日后自动推算属相（优先按农历年份）
        const year = Number((data.birthday_lunar || bdInput.value).split('-')[0]);
        const zodSelect = els.memberForm.querySelector('#f_zodiac');
        if (year && zodSelect) {
          zodSelect.value = ZODIAC[(((year - 4) % 12) + 12) % 12];
        }
      } catch (err) {
        bdHint.textContent = err.message;
      }
    };
    if (bdInput && bdType) {
      bdInput.addEventListener('change', refreshBirthday);
      bdType.addEventListener('change', refreshBirthday);
    }

    // 选择父节点后，代际自动为父节点代际 + 1
    const fatherSelect = els.memberForm.querySelector('#f_father_id');
    const genInput = els.memberForm.querySelector('#f_generation');
    if (fatherSelect && genInput) {
      fatherSelect.addEventListener('change', () => {
        const father = state.members.find(x => String(x.member_id) === fatherSelect.value);
        if (father) genInput.value = Number(father.generation) + 1;
      });
    }
  }

  // 配偶编辑器：只展示已关联配偶，逐个添加/移除
  function renderSpouseEditor() {
    const tags = els.memberForm.querySelector('#spouseTags');
    const pick = els.memberForm.querySelector('#f_spouse_pick');
    if (!tags || !pick) return;

    tags.innerHTML = state.formSpouses.length
      ? state.formSpouses.map(sp =>
        `<span class="spouse-tag">${esc(sp.name)}<button type="button" class="spouse-tag-x"
          data-remove-spouse="${sp.id}" title="移除该配偶">×</button></span>`).join('')
      : '<span class="spouse-empty">尚未关联配偶</span>';

    const linked = new Set(state.formSpouses.map(s => s.id));
    const selfId = state.editId;
    const candidates = sortMembers(
      state.members.filter(x => x.member_id !== selfId && !linked.has(x.member_id)),
    );
    pick.innerHTML = '<option value="">选择要添加的成员…</option>' + candidates.map(x =>
      `<option value="${x.member_id}">${generationText(x.generation)} · ${esc(x.name)}（${esc(x.code)}）</option>`,
    ).join('');
  }

  function enterEdit() {
    const m = state.detail;
    if (!m) return;
    state.editId = m.member_id;
    buildForm(m);
    els.modalTitle.textContent = `编辑 · ${m.name}`;
    els.modalSub.textContent = '修改后将同步人员信息表与关系表';
    els.detailView.classList.add('hidden');
    els.memberForm.classList.remove('hidden');
    renderPhoto(m.photo, m.name);
    els.uploadLabel.classList.toggle('hidden', !m.can_edit);
    if (state.role === 'normal') {
      // 普通成员仅可修改个人资料，关系与代际字段只读
      els.memberForm.querySelectorAll(
        '#f_code,#f_sibling_rank,#f_generation,#f_relation_type,#f_father_id,#f_mother_id,#f_spouse_pick,#btnSpouseAdd',
      ).forEach(el => { el.disabled = true; });
      els.memberForm.querySelectorAll('.spouse-tag-x').forEach(el => el.remove());
      const note = els.memberForm.querySelector('.form-note');
      if (note) note.textContent = '普通成员仅可修改本人绑定的身份资料，父母、配偶、代际等关系字段不可修改。';
    }
    els.modalFoot.innerHTML = `
      <button class="btn primary" data-action="save">保存修改</button>
      <button class="btn ghost" data-action="cancel">取消</button>
      <span class="spacer"></span>
      ${isAdmin() ? '<button class="btn danger" data-action="delete">删除成员</button>' : ''}`;
  }

  function openCreate() {
    state.detail = null;
    state.editId = null;
    els.modalTitle.textContent = '新增成员';
    els.modalSub.textContent = isAdmin() ? '保存后自动生成唯一编码与关系表记录' : '分支管理员新增需管理员审批';
    buildForm(null);
    els.detailView.classList.add('hidden');
    els.memberForm.classList.remove('hidden');
    els.photoFrame.innerHTML = '<span class="photo-empty">保存后可上传照片</span>';
    els.uploadLabel.classList.add('hidden');
    els.modalFoot.innerHTML = `
      <button class="btn primary" data-action="save">创建成员</button>
      <button class="btn ghost" data-action="cancel">取消</button>`;
    openModal();
    const nameInput = els.memberForm.querySelector('#f_name');
    if (nameInput) setTimeout(() => nameInput.focus(), 120);
  }

  function readNumber(id) {
    const value = els.memberForm.querySelector(`#${id}`).value.trim();
    return value === '' ? null : Number(value);
  }

  function collectForm() {
    const form = els.memberForm;
    return {
      name: form.querySelector('#f_name').value.trim(),
      code: form.querySelector('#f_code').value.trim(),
      gender: form.querySelector('#f_gender').value,
      birth_year: readNumber('f_birth_year'),
      death_year: readNumber('f_death_year'),
      birthday: form.querySelector('#f_birthday').value,
      birthday_type: form.querySelector('#f_birthday_type').checked ? 'lunar' : 'solar',
      zodiac: form.querySelector('#f_zodiac').value,
      hometown: form.querySelector('#f_hometown').value.trim(),
      residence: form.querySelector('#f_residence').value.trim(),
      contact: form.querySelector('#f_contact').value.trim(),
      sibling_rank: readNumber('f_sibling_rank'),
      generation: readNumber('f_generation'),
      relation_type: form.querySelector('#f_relation_type').value,
      father_id: readNumber('f_father_id'),
      mother_id: readNumber('f_mother_id'),
      photo: form.querySelector('#f_photo').value.trim(),
      spouse_ids: state.formSpouses.map(sp => sp.id),
    };
  }

  async function saveMember() {
    const payload = collectForm();
    if (!payload.name) { toast('请填写姓名', true); return; }
    try {
      if (state.editId) {
        const saved = await api(`${API_BASE}/members/${state.editId}`, { method: 'PUT', body: payload });
        toast(`已保存「${saved.name}」的资料`);
        await afterSave(saved.member_id);
      } else {
        const res = await api(`${API_BASE}/members`, { method: 'POST', body: payload });
        if (res && res.submitted) {
          toast('已提交管理员审批，请等待管理员同意');
          closeModal();
        } else {
          toast(`已新增「${res.name}」`);
          await afterSave(res.member_id);
        }
      }
    } catch (err) { toast(err.message, true); }
  }

  async function afterSave(savedId) {
    await loadMembers();
    if (state.view === 'relations') await loadRelations();
    await reloadTree();
    closeModal();
    await openDetail(savedId);
  }

  async function deleteMember(memberId, name) {
    if (!memberId) return;
    if (!window.confirm(`确定删除「${name}」？\n其关系表记录与配偶关联会一并清除，此操作不可恢复。`)) return;
    try {
      await api(`${API_BASE}/members/${memberId}`, { method: 'DELETE' });
      toast(`已删除「${name}」`);
      closeModal();
      await loadMembers();
      if (state.view === 'relations') await loadRelations();
      await reloadTree();
    } catch (err) { toast(err.message, true); }
  }

  async function uploadPhoto(file) {
    if (!file || !state.detail) return;
    const form = new FormData();
    form.append('photo', file);
    try {
      const data = await api(`${API_BASE}/members/${state.detail.member_id}/photo`, { method: 'POST', body: form });
      state.detail.photo = data.photo;
      renderPhoto(state.detail.photo, state.detail.name);
      const photoField = els.memberForm.querySelector('#f_photo');
      if (photoField) photoField.value = data.photo;
      toast('照片已更新');
      await loadMembers();
      await reloadTree();
    } catch (err) { toast(err.message, true); }
    finally { els.photoInput.value = ''; }
  }

  /* ---------- 视图切换 ---------- */
  // 家谱页的「亲戚谱」入口：跳转到本人新生成的亲戚谱族谱
  // focusSourceId：源家谱成员 ID，进入亲戚谱后定位到对应成员
  async function openMyKinship(focusSourceId) {
    try {
      if (state.myKinshipId == null) {
        const list = await api('/api/genealogies');
        const user = JSON.parse(localStorage.getItem('user') || '{}');
        const own = (list || []).find(
          g => g.kind === 'kinship' && g.owner_user_id === user.id
        );
        state.myKinshipId = own ? own.id : null;
      }
      if (!state.myKinshipId) {
        // 无本人亲戚谱（如游客）：留在当前家谱，用三支视图查看亲戚谱
        return false;
      }
      if (state.myKinshipId === state.genealogy.id) {
        // 已在亲戚谱中：直接定位到对应成员
        const matched = state.members.find(
          m => Number(m.source_member_id) === Number(focusSourceId)
        );
        if (matched) {
          state.lineageRootId = matched.member_id;
          switchView('lineage');
        }
        return true;
      }
      if (focusSourceId) sessionStorage.setItem('kinship_focus_source_id', String(focusSourceId));
      else sessionStorage.removeItem('kinship_focus_source_id');
      localStorage.setItem('genealogy_id', String(state.myKinshipId));
      window.location.href = '/';
      return true;
    } catch (err) { toast(err.message, true); return false; }
  }

  function applyViewChrome(view) {
    Array.from(els.tabs.querySelectorAll('.tab')).forEach(tab => {
      tab.classList.toggle('active', tab.dataset.view === view);
    });
    // 工具栏与面板可见性
    const isKinship = state.kind === 'kinship';
    els.lineageToolbar.classList.toggle('hidden', view !== 'lineage' || isKinship);
    els.branchToolbar.classList.toggle('hidden', view !== 'lineage' || !isKinship);
    els.kinshipToolbar.classList.toggle('hidden', view !== 'kinship');
    const treeViews = ['lineage', 'kinship'];
    els.canvasWrap.classList.toggle('hidden', !treeViews.includes(view));
    els.relationsPanel.classList.toggle('hidden', view !== 'relations');
    els.membersPanel.classList.toggle('hidden', view !== 'members');
    els.permissionsPanel.classList.toggle('hidden', view !== 'permissions');
    els.proposalsPanel.classList.toggle('hidden', view !== 'proposals');
    // 侧栏：成员管理/权限/审批时隐藏目录
    const showSidebar = ['lineage', 'kinship', 'relations', 'members'].includes(view);
    $('sidebar').style.display = showSidebar ? '' : 'none';
  }

  function switchView(view) {
    state.view = view;
    applyViewChrome(view);
    fillSelects();
    renderDirectory();
    if (view === 'lineage') loadLineage();
    if (view === 'kinship') loadKinship();
    if (view === 'relations') loadRelations();
    if (view === 'members') renderMembersTable();
    if (view === 'permissions') loadPermissions();
    if (view === 'proposals') loadProposals();
  }

  /* ---------- 权限管理 ---------- */
  async function loadPermissions() {
    try {
      state.users = await api(`${API_BASE}/users`);
      renderPermissions();
    } catch (err) {
      els.usersBody.innerHTML = `<tr><td colspan="5" class="none">${esc(err.message)}</td></tr>`;
    }
  }

  function renderPermissions() {
    if (!state.users.length) {
      els.usersBody.innerHTML = '<tr><td colspan="5" class="none">暂无协作者</td></tr>';
      return;
    }
    const canEdit = isAdmin() && state.kind !== 'kinship';
    const members = sortMembers(state.members);
    els.usersBody.innerHTML = state.users.map(u => {
      const roleOpts = ['normal', 'branch_admin'].map(r =>
        `<option value="${r}"${u.role === r ? ' selected' : ''}>${ROLE_LABEL[r]}</option>`).join('');
      const boundElsewhere = new Set(state.users
        .filter(other => other.user_id !== u.user_id && other.member_id != null)
        .map(other => other.member_id));
      const memberOpts = members.map(m =>
        `<option value="${m.member_id}"${u.member_id === m.member_id ? ' selected' : ''}${boundElsewhere.has(m.member_id) ? ' disabled' : ''}>${esc(generationText(m.generation))} · ${esc(m.name)}</option>`).join('');
      return `<tr data-uid="${u.user_id}">
        <td>${esc(u.username)}</td>
        <td>${esc(u.display_name || '')}</td>
        <td>${u.role === 'admin'
          ? '<span class="role-pill role-admin">管理员</span>'
          : `<select class="role-select" ${canEdit ? '' : 'disabled'}>${roleOpts}</select>`}</td>
        <td>${canEdit
          ? `<select class="member-bind-select" aria-label="绑定谱成员"><option value="">未绑定</option>${memberOpts}</select>`
          : (u.member_name ? esc(u.member_name) : '<span class="none">未绑定</span>')}</td>
        <td class="row-actions">
          ${u.role === 'admin'
            ? '<span class="none">本人</span>'
            : canEdit ? `<button class="link-btn danger" data-act="remove">移除</button>` : ''}
        </td>
      </tr>`;
    }).join('');
    // 转让目标下拉
    const candidates = state.users.filter(u => u.role !== 'admin');
    els.transferTarget.innerHTML = candidates.length
      ? candidates.map(u => `<option value="${u.user_id}">${esc(u.display_name || u.username)}（${u.username}）</option>`).join('')
      : '<option value="">无可转让对象</option>';
    // 非管理员隐藏添加与转让
    $('btnAddUser').style.display = canEdit ? '' : 'none';
    document.querySelector('.transfer-box').style.display = canEdit ? '' : 'none';
  }

  els.usersBody.addEventListener('change', async e => {
    const roleSel = e.target.closest('.role-select');
    if (roleSel) {
      const uid = Number(roleSel.closest('tr').dataset.uid);
      const role = roleSel.value;
      try {
        await api(`${API_BASE}/users/${uid}`, { method: 'PUT', body: { role } });
        toast(`角色已更新为「${ROLE_LABEL[role]}」`);
        loadPermissions();
      } catch (err) { toast(err.message, true); loadPermissions(); }
      return;
    }
    const bindSel = e.target.closest('.member-bind-select');
    if (!bindSel) return;
    const uid = Number(bindSel.closest('tr').dataset.uid);
    const memberId = bindSel.value ? Number(bindSel.value) : null;
    try {
      await api(`${API_BASE}/users/${uid}`, { method: 'PUT', body: { member_id: memberId } });
      const member = memberById(memberId);
      toast(memberId ? `已绑定「${member ? member.name : '谱成员'}」` : '已解除谱成员绑定');
      loadPermissions();
    } catch (err) { toast(err.message, true); loadPermissions(); }
  });

  els.usersBody.addEventListener('click', async e => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const tr = btn.closest('tr');
    const uid = Number(tr.dataset.uid);
    const u = state.users.find(x => x.user_id === uid);
    if (btn.dataset.act === 'remove') {
      if (!window.confirm(`确定将「${u.display_name || u.username}」移出本族谱？`)) return;
      try {
        await api(`${API_BASE}/users/${uid}`, { method: 'DELETE' });
        toast('已移除');
        loadPermissions();
      } catch (err) { toast(err.message, true); }
    }
  });

  $('btnAddUser').addEventListener('click', () => {
    els.userModalMask.classList.remove('hidden');
    $('f_username').value = '';
    $('f_role').value = 'normal';
    setTimeout(() => $('f_username').focus(), 80);
  });
  $('userModalClose').addEventListener('click', () => els.userModalMask.classList.add('hidden'));
  $('cancelAddUser').addEventListener('click', () => els.userModalMask.classList.add('hidden'));
  els.userModalMask.addEventListener('click', e => { if (e.target === els.userModalMask) els.userModalMask.classList.add('hidden'); });
  $('confirmAddUser').addEventListener('click', async () => {
    const username = $('f_username').value.trim();
    const role = $('f_role').value;
    if (!username) { toast('请填写用户名', true); return; }
    try {
      await api(`${API_BASE}/users`, { method: 'POST', body: { username, role } });
      els.userModalMask.classList.add('hidden');
      toast('已添加协作者');
      loadPermissions();
    } catch (err) { toast(err.message, true); }
  });

  $('btnTransfer').addEventListener('click', async () => {
    const tid = Number(els.transferTarget.value);
    if (!tid) { toast('请选择转让对象', true); return; }
    if (!window.confirm('确认转让管理员权限？转让后你将变为普通成员。')) return;
    try {
      await api(`${API_BASE}/transfer`, { method: 'POST', body: { new_admin_id: tid } });
      toast('管理员权限已转让');
      // 重新拉取角色
      await loadBootstrap();
      loadPermissions();
    } catch (err) { toast(err.message, true); }
  });

  /* ---------- 审批 ---------- */
  async function loadProposals() {
    try {
      state.proposals = await api(`${API_BASE}/proposals`);
      renderProposals();
    } catch (err) {
      els.proposalList.innerHTML = `<div class="none">${esc(err.message)}</div>`;
    }
  }

  function renderProposals() {
    const pending = state.proposals.filter(p => p.status === 'pending');
    els.proposalDot.classList.toggle('hidden', !isAdmin() || pending.length === 0);
    els.proposalMeta.textContent = `共 ${state.proposals.length} 条 · 待审 ${pending.length} 条`;
    if (!state.proposals.length) {
      els.proposalList.innerHTML = '<div class="empty-inline">暂无审批记录</div>';
      return;
    }
    els.proposalList.innerHTML = state.proposals.map(p => {
      const pl = p.payload || {};
      const isJoin = p.action === 'join_bind';
      const targetName = p.target_member_name || (pl.member_id ? `#${pl.member_id}` : '未知成员');
      const statusCls = p.status === 'approved' ? 'ok' : p.status === 'rejected' ? 'err' : 'pending';
      return `<div class="proposal-card" data-pid="${p.id}">
        <div class="pc-head">
          <span class="pc-name">${isJoin ? `加入并绑定：${esc(targetName)}` : esc(pl.name || '(未命名)')}</span>
          <span class="status-pill ${statusCls}">${p.status === 'approved' ? '已通过' : p.status === 'rejected' ? '已驳回' : '待审批'}</span>
        </div>
        <div class="pc-meta">
          类型：${isJoin ? '加入并绑定' : '新增成员'} · 申请人：${esc(p.proposer_display || p.proposer_name)} · 提交于 ${(p.created_at || '').slice(0, 16)}
        </div>
        <div class="pc-fields">
          ${isJoin ? `
            <span>目标成员 ${esc(targetName)}</span>
            <span>通过后成为普通成员</span>
            <span>绑定后仅管理员可更改</span>` : `
            <span>性别 ${esc(pl.gender || '—')}</span>
            <span>代际 ${esc(pl.generation || '—')}</span>
            <span>出生 ${esc(pl.birth_year || '—')}</span>
            <span>籍贯 ${esc(pl.hometown || '—')}</span>`}
        </div>
        ${p.reject_reason ? `<div class="pc-reject">驳回原因：${esc(p.reject_reason)}</div>` : ''}
        ${p.status === 'pending' && isAdmin() ? `
          <div class="pc-actions">
            <button class="btn primary" data-act="approve">同意</button>
            <button class="btn danger" data-act="reject">驳回</button>
          </div>` : ''}
      </div>`;
    }).join('');
  }

  els.proposalList.addEventListener('click', async e => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const card = btn.closest('.proposal-card');
    const pid = Number(card.dataset.pid);
    const proposal = state.proposals.find(p => p.id === pid);
    const act = btn.dataset.act;
    try {
      if (act === 'approve') {
        await api(`${API_BASE}/proposals/${pid}/approve`, { method: 'POST' });
        if (proposal && proposal.action === 'join_bind') {
          toast('已同意，用户已加入并绑定谱成员');
          await loadPermissions();
        } else {
          toast('已同意，成员已创建');
          await loadMembers();
          await reloadTree();
        }
      } else if (act === 'reject') {
        const reason = window.prompt('请填写驳回原因（可选）') || '';
        await api(`${API_BASE}/proposals/${pid}/reject`, { method: 'POST', body: { reason } });
        toast('已驳回');
      }
      loadProposals();
    } catch (err) { toast(err.message, true); }
  });

  /* ---------- 导入 / 导出 ---------- */
  document.querySelectorAll('[data-export]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const fmt = btn.dataset.export;
      btn.disabled = true;
      try {
        const res = await fetch(`${API_BASE}/export?format=${fmt}`, {
          headers: { 'Authorization': 'Bearer ' + TOKEN },
        });
        if (res.status === 401) {
          localStorage.removeItem('token'); localStorage.removeItem('user');
          localStorage.removeItem('genealogy_id');
          window.location.href = '/login';
          return;
        }
        if (!res.ok) {
          let message = '导出失败';
          try {
            const data = await res.json();
            if (data && data.error) message = data.error;
          } catch (err) { /* 非 JSON 错误响应 */ }
          throw new Error(message);
        }
        const blob = await res.blob();
        const disposition = res.headers.get('Content-Disposition') || '';
        const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
        let filename = `family.${fmt}`;
        if (match) {
          try { filename = decodeURIComponent(match[1]); } catch (err) { filename = match[1]; }
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1500);
        toast('导出已开始下载');
      } catch (err) {
        toast(err.message || '导出失败', true);
      } finally {
        btn.disabled = false;
      }
    });
  });

  $('importFile').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    const status = $('importStatus');
    status.textContent = '上传中…';
    const fd = new FormData();
    fd.append('file', file);
    try {
      const res = await api(`${API_BASE}/import`, { method: 'POST', body: fd });
      status.textContent = `导入完成：成功 ${res.imported} / 共 ${res.total} 条`;
      await loadMembers();
      await reloadTree();
    } catch (err) {
      status.textContent = '失败：' + err.message;
    } finally { e.target.value = ''; }
  });

  /* ---------- 事件绑定 ---------- */
  function bindEvents() {
    els.tabs.addEventListener('click', event => {
      const tab = event.target.closest('.tab');
      if (!tab) return;
      // 家谱页的「亲戚谱」跳转到本人新生成的亲戚谱族谱
      if (tab.dataset.view === 'kinship' && state.kind !== 'kinship') {
        openMyKinship().then(ok => { if (!ok) switchView('kinship'); });
        return;
      }
      switchView(tab.dataset.view);
    });

    els.btnAdd.addEventListener('click', openCreate);
    $('btnAddMember2').addEventListener('click', openCreate);

    els.searchInput.addEventListener('input', () => {
      state.search = els.searchInput.value;
      renderDirectory();
      applySearchHighlight();
      if (state.view === 'relations') renderRelationTable();
      if (state.view === 'members') renderMembersTable();
    });

    els.memberList.addEventListener('click', event => {
      const item = event.target.closest('.member-item');
      if (item) openDetail(Number(item.dataset.person));
    });

    els.relationBody.addEventListener('click', event => {
      const row = event.target.closest('tr[data-person]');
      if (row) {
        const btn = event.target.closest('button[data-act]');
        if (btn) {
          if (btn.dataset.act === 'edit') { openDetail(Number(row.dataset.person)).then(() => enterEdit()); }
          return;
        }
        openDetail(Number(row.dataset.person));
      }
    });

    els.membersBody.addEventListener('click', event => {
      const row = event.target.closest('tr[data-person]');
      if (!row) return;
      const btn = event.target.closest('button[data-act]');
      const id = Number(row.dataset.person);
      if (btn) {
        if (btn.dataset.act === 'edit') openDetail(id).then(() => enterEdit());
        else if (btn.dataset.act === 'delete') {
          const m = memberById(id);
          deleteMember(id, m ? m.name : '');
        }
        return;
      }
      openDetail(id);
    });

    els.lineageRoot.addEventListener('change', () => {
      state.lineageRootId = Number(els.lineageRoot.value);
      renderDirectory(); loadLineage();
    });
    els.lineageMax.addEventListener('change', () => { state.lineageMax = Number(els.lineageMax.value); loadLineage(); });
    els.lineageRefresh.addEventListener('click', loadLineage);

    els.kinshipFocus.addEventListener('change', () => {
      state.kinshipFocusId = Number(els.kinshipFocus.value);
      renderDirectory(); loadKinship();
    });
    els.kinshipRefresh.addEventListener('click', loadKinship);

    els.branchSwitch.addEventListener('click', event => {
      const btn = event.target.closest('button[data-branch]');
      if (!btn) return;
      const value = btn.dataset.branch;
      state.branchAll = value === 'all';
      if (!state.branchAll) state.branch = value;
      Array.from(els.branchSwitch.children).forEach(b => b.classList.toggle('active', b === btn));
      loadBranches();
    });

    els.branchGrid.addEventListener('click', event => {
      const spouse = event.target.closest('.spouse-card');
      if (spouse) { openDetail(Number(spouse.dataset.id)); return; }
      const node = event.target.closest('g.node');
      if (node) openDetail(Number(node.dataset.id));
    });

    document.querySelectorAll('[data-zoom]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.zoom === 'in') zoomBy(1.2);
        else if (btn.dataset.zoom === 'out') zoomBy(1 / 1.2);
        else fitToBounds();
      });
    });

    let drag = null;
    els.treeSvg.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      drag = { x: event.clientX, y: event.clientY, pan: Object.assign({}, state.pan) };
      state.moved = false;
      els.treeSvg.classList.add('is-dragging');
      try { els.treeSvg.setPointerCapture(event.pointerId); } catch (err) { /* ignore */ }
    });
    els.treeSvg.addEventListener('pointermove', event => {
      if (!drag) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) state.moved = true;
      state.pan.x = drag.pan.x + dx;
      state.pan.y = drag.pan.y + dy;
      applyTransform();
    });
    const endDrag = () => { drag = null; els.treeSvg.classList.remove('is-dragging'); };
    els.treeSvg.addEventListener('pointerup', endDrag);
    els.treeSvg.addEventListener('pointercancel', endDrag);
    els.treeSvg.addEventListener('pointerleave', () => { if (!drag) els.treeSvg.classList.remove('is-dragging'); });

    els.treeSvg.addEventListener('click', event => {
      if (state.moved) { state.moved = false; return; }
      const spouse = event.target.closest('.spouse-card');
      if (spouse) { openDetail(Number(spouse.dataset.id)); return; }
      const node = event.target.closest('g.node');
      if (node) openDetail(Number(node.dataset.id));
    });

    els.canvasWrap.addEventListener('wheel', event => {
      if (state.view === 'relations') return;
      if (!els.branchGrid.classList.contains('hidden')) return;
      event.preventDefault();
      const rect = els.treeSvg.getBoundingClientRect();
      zoomBy(event.deltaY < 0 ? 1.12 : 1 / 1.12, event.clientX - rect.left, event.clientY - rect.top);
    }, { passive: false });

    els.modalClose.addEventListener('click', closeModal);
    els.modalMask.addEventListener('click', event => { if (event.target === els.modalMask) closeModal(); });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !els.modalMask.classList.contains('hidden')) closeModal();
    });

    els.detailView.addEventListener('click', event => {
      const chip = event.target.closest('.person-chip');
      if (chip) openDetail(Number(chip.dataset.person));
    });

    els.modalFoot.addEventListener('click', event => {
      const btn = event.target.closest('button[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === 'close') closeModal();
      else if (action === 'edit') enterEdit();
      else if (action === 'cancel') {
        if (state.detail) { state.editId = null; renderDetailState(state.detail); }
        else closeModal();
      } else if (action === 'save') {
        if (els.memberForm.requestSubmit) els.memberForm.requestSubmit();
        else els.memberForm.dispatchEvent(new Event('submit', { cancelable: true }));
      } else if (action === 'delete' && state.detail) {
        deleteMember(state.detail.member_id, state.detail.name);
      } else if (action === 'set-root' && state.detail) {
        const target = state.detail;
        state.lineageRootId = target.member_id;
        closeModal();
        switchView('lineage');
        toast(`已将「${target.name}」设为宗谱始祖`);
      } else if (action === 'kin-father' && state.detail) {
        const detail = state.detail;
        closeModal();
        const targetId = detail.father_id || detail.member_id;
        openMyKinship(targetId).then(ok => {
          if (!ok) {
            state.kinshipFocusId = detail.member_id;
            switchView('kinship');
          }
        });
      } else if (action === 'kin-mother' && state.detail) {
        const detail = state.detail;
        closeModal();
        const targetId = detail.mother_id || detail.member_id;
        openMyKinship(targetId).then(ok => {
          if (!ok) {
            state.kinshipFocusId = detail.member_id;
            switchView('kinship');
          }
        });
      }
    });

    els.memberForm.addEventListener('submit', event => { event.preventDefault(); saveMember(); });

    // 配偶编辑器：添加 / 移除
    els.memberForm.addEventListener('click', event => {
      const removeBtn = event.target.closest('[data-remove-spouse]');
      if (removeBtn) {
        const sid = Number(removeBtn.dataset.removeSpouse);
        state.formSpouses = state.formSpouses.filter(sp => sp.id !== sid);
        renderSpouseEditor();
        return;
      }
      const addBtn = event.target.closest('#btnSpouseAdd');
      if (addBtn) {
        const pick = els.memberForm.querySelector('#f_spouse_pick');
        const sid = Number(pick.value);
        if (!sid) { toast('请先选择要添加的成员', true); return; }
        if (state.formSpouses.some(sp => sp.id === sid)) return;
        const mem = memberById(sid);
        state.formSpouses.push({ id: sid, name: mem ? mem.name : `#${sid}` });
        renderSpouseEditor();
      }
    });

    els.photoInput.addEventListener('change', () => { const file = els.photoInput.files[0]; if (file) uploadPhoto(file); });

    window.addEventListener('resize', () => { if (state.view !== 'relations') fitToBounds(); });

    // 用户菜单
    els.userBtn.addEventListener('click', e => {
      e.stopPropagation();
      els.userDropdown.classList.toggle('hidden');
    });
    document.addEventListener('click', () => els.userDropdown.classList.add('hidden'));
    els.userDropdown.addEventListener('click', e => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const act = btn.dataset.action;
      els.userDropdown.classList.add('hidden');
      if (act === 'io') els.ioModalMask.classList.remove('hidden');
      else if (act === 'profile') { window.location.href = '/me'; }
      else if (act === 'switch') { localStorage.removeItem('genealogy_id'); window.location.href = '/home'; }
      else if (act === 'logout') {
        api('/api/auth/logout', { method: 'POST' }).catch(() => {});
        localStorage.removeItem('token'); localStorage.removeItem('user'); localStorage.removeItem('genealogy_id');
        window.location.href = '/login';
      }
    });

    // IO 弹窗关闭
    $('ioModalClose').addEventListener('click', () => els.ioModalMask.classList.add('hidden'));
    $('closeIo').addEventListener('click', () => els.ioModalMask.classList.add('hidden'));
    els.ioModalMask.addEventListener('click', e => { if (e.target === els.ioModalMask) els.ioModalMask.classList.add('hidden'); });
  }

  function renderDetailState(member) {
    state.detail = member;
    els.modalTitle.textContent = member.name;
    els.modalSub.textContent = `${member.code} · ${generationText(member.generation)} · 关系表第 ${member.relation_id || '—'} 行`;
    els.memberForm.classList.add('hidden');
    els.detailView.classList.remove('hidden');
    els.uploadLabel.classList.toggle('hidden', !member.can_edit);
    renderDetailView(member);
    renderDetailFoot(member);
    renderPhoto(member.photo, member.name);
  }

  /* ---------- 启动 ---------- */
  async function boot() {
    bindEvents();
    try {
      await loadBootstrap();
      await loadMembers();
      await loadLineage();
      // 预拉审批红点
      if (isAdmin()) loadProposals().then(() => {
        const pending = state.proposals.filter(p => p.status === 'pending');
        els.proposalDot.classList.toggle('hidden', pending.length === 0);
      });
    } catch (err) {
      toast(err.message, true);
      showCanvasMessage('加载失败', err.message);
    }
  }

  boot();
})();
