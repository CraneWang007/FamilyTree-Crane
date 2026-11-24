const api = require('../../utils/api')

const GEN_OPTIONS = [3, 5, 10, 20, 30]
const ROLE_LABEL = { admin: '管理员', branch_admin: '分支管理员', normal: '成员' }

function yearRange(node) {
  if (node.birth_year || node.death_year) {
    return (node.birth_year || '?') + (node.death_year ? '—' + node.death_year : '—')
  }
  return ''
}

function metaOf(node) {
  const meta = []
  if (node.generation) meta.push('第' + node.generation + '代')
  const years = yearRange(node)
  if (years) meta.push(years)
  return meta.join(' · ')
}

function spouseMetaOf(sp, fallbackGen) {
  const meta = ['配偶', '第' + (sp.generation || fallbackGen || 1) + '代']
  const years = yearRange(sp)
  if (years) meta.push(years)
  return meta.join(' · ')
}

function genClassOf(generation) {
  return 'gen' + ((((generation || 1) - 1) % 7) + 1)
}

function countDescendants(node) {
  let total = 0
  ;(node.children || []).forEach(function (child) {
    total += 1 + countDescendants(child)
  })
  return total
}

function rowOf(node, depth, focusId, myId, key, collapsed) {
  const highlight = myId || focusId
  const isCollapsed = !!collapsed[node.id]
  return {
    type: 'node',
    key: key,
    id: node.id,
    name: node.name,
    initial: (node.name || '?').slice(0, 1),
    genderClass: node.gender === '女' ? 'female' : 'male',
    metaText: metaOf(node),
    genClass: genClassOf(node.generation),
    isFocus: node.id === highlight,
    isMine: node.id === myId,
    indent: Math.min(depth, 6) * 30,
    hasChildren: !!(node.children && node.children.length),
    collapsed: isCollapsed,
    hiddenCount: isCollapsed ? countDescendants(node) : 0,
    spouses: (node.spouses || []).map(function (sp) {
      return {
        id: sp.id,
        name: sp.name,
        initial: (sp.name || '?').slice(0, 1),
        genderClass: sp.gender === '女' ? 'female' : 'male',
        metaText: spouseMetaOf(sp, node.generation)
      }
    })
  }
}

// 把递归树拍平成带层级缩进的列表，避免 WXML 递归模板渲染不全
function flattenTree(root, focusId, myId, collapsed) {
  const rows = []
  const anchor = {}
  collapsed = collapsed || {}
  ;(function walk(node, depth) {
    if (!node || !node.id || anchor[node.id]) return
    const key = 'r' + node.id
    anchor[node.id] = key
    rows.push(rowOf(node, depth, focusId, myId, key, collapsed))
    ;(node.spouses || []).forEach(function (sp) {
      if (sp && sp.id) anchor[sp.id] = key
    })
    if (collapsed[node.id]) return
    ;(node.children || []).forEach(function (child) {
      walk(child, depth + 1)
    })
  })(root, 0)
  return { rows: rows, anchor: anchor }
}

function memberLabel(m) {
  return '第' + (m.generation || 1) + '代 · ' + m.name
}

Page({
  data: {
    genealogyId: 0,
    genealogy: null,
    isKinship: false,
    isDefault: false,
    role: 'normal',
    roleLabel: '成员',
    roleClass: 'pill-normal',
    isAdmin: false,
    isVisitor: false,
    canAdd: false,
    canApprove: false,
    canManage: false,
    pendingCount: 0,

    mode: 'lineage',
    branch: 'father',
    loading: true,
    rows: [],
    scrollToId: '',
    located: false,
    myMemberId: 0,
    myMemberName: '',
    ancestors: [],
    hint: '',

    members: [],
    rootLabels: ['自动选择起始祖先'],
    rootIndex: 0,
    genLabels: GEN_OPTIONS.map(function (n) { return n + ' 代' }),
    maxGenIndex: 4,

    focusLabels: [],
    focusIndex: 0,
    sideLabels: ['父系', '母系', '配偶父系', '配偶母系'],
    sideIndex: 0,

    zoomSteps: [0.6, 0.75, 0.9, 1, 1.25, 1.5, 1.8],
    zoomIndex: 3,
    zoom: 1,
    zoomText: '100%',
    baseWidth: 0,
    baseHeight: 0,
    shelfWidth: 0,
    treeHeight: 0
  },

  onLoad: function (options) {
    const id = Number(options.genealogy_id || wx.getStorageSync('genealogy_id') || 0)
    if (!id) {
      wx.showToast({ title: '请先选择族谱', icon: 'none' })
      setTimeout(function () { wx.switchTab({ url: '/pages/index/index' }) }, 600)
      return
    }
    this.memberIds = {}
    this.anchorMap = {}
    this.setData({ genealogyId: id })
    this.loadAll(id)
  },

  onShow: function () {
    if (this.data.genealogyId && this.needRefresh) {
      this.needRefresh = false
      this.loadMembers().then(this.loadTree.bind(this))
    }
  },

  loadAll: function (id) {
    const that = this
    Promise.all([
      api.request('/api/genealogies/' + id),
      api.request('/api/genealogies/' + id + '/members')
    ]).then(function (res) {
      const genealogy = res[0] || {}
      const members = (res[1] || []).slice().sort(function (a, b) {
        return (a.generation || 1) - (b.generation || 1) || a.member_id - b.member_id
      })
      const role = genealogy.role || ''
      const isKinship = genealogy.kind === 'kinship'
      const myMemberId = genealogy.my_member_id || 0
      let focusIndex = that.data.focusIndex
      if (myMemberId) {
        for (let i = 0; i < members.length; i++) {
          if (members[i].member_id === myMemberId) { focusIndex = i; break }
        }
      }
      that.memberIds = {}
      members.forEach(function (m) { that.memberIds[m.member_id] = true })
      that.setData({
        genealogy: genealogy,
        isKinship: isKinship,
        isDefault: !!genealogy.is_default,
        mode: isKinship ? 'lineage' : that.data.mode,
        role: role,
        roleLabel: ROLE_LABEL[role] || '访客',
        roleClass: role === 'admin' ? 'pill-admin' : role === 'branch_admin' ? 'pill-branch' : 'pill-normal',
        isAdmin: role === 'admin',
        isVisitor: !role,
        canAdd: role === 'admin' || role === 'branch_admin',
        canApprove: role === 'admin',
        canManage: !!role,
        myMemberId: myMemberId,
        myMemberName: genealogy.my_member_name || '',
        members: members,
        rootLabels: ['自动选择起始祖先'].concat(members.map(memberLabel)),
        focusLabels: members.length ? members.map(memberLabel) : ['暂无成员'],
        focusIndex: focusIndex
      })
      that.loadTree()
      that.loadPending()
    }).catch(function (err) {
      that.setData({ loading: false })
      api.toastError(err)
    })
  },

  loadMembers: function () {
    const that = this
    return api.request('/api/genealogies/' + this.data.genealogyId + '/members').then(function (list) {
      const members = (list || []).slice().sort(function (a, b) {
        return (a.generation || 1) - (b.generation || 1) || a.member_id - b.member_id
      })
      that.memberIds = {}
      members.forEach(function (m) { that.memberIds[m.member_id] = true })
      that.setData({
        members: members,
        rootLabels: ['自动选择起始祖先'].concat(members.map(memberLabel)),
        focusLabels: members.length ? members.map(memberLabel) : ['暂无成员']
      })
    }).catch(function () {})
  },

  loadPending: function () {
    const that = this
    if (!this.data.canApprove && this.data.role !== 'branch_admin') return
    api.request('/api/genealogies/' + this.data.genealogyId + '/proposals').then(function (list) {
      const pending = (list || []).filter(function (p) { return p.status === 'pending' })
      that.setData({ pendingCount: pending.length })
    }).catch(function () {})
  },

  switchMode: function (e) {
    const mode = e.currentTarget.dataset.mode
    if (mode === this.data.mode) return
    // 家谱页的「亲戚谱」入口：优先跳转本人亲戚谱，无本人亲戚谱时回退到内嵌三支视图
    if (mode === 'kinship') {
      this.openMyKinship().then(function (handled) {
        if (handled) return
        this.setData({ mode: 'kinship', rows: [], ancestors: [], scrollToId: '', loading: true })
        this.loadTree()
      }.bind(this))
      return
    }
    this.setData({ mode: mode, rows: [], ancestors: [], scrollToId: '', loading: true })
    this.loadTree()
  },

  openMyKinship: function () {
    const that = this
    const app = getApp()
    const user = (app && app.globalData.user) || wx.getStorageSync('user') || {}
    return api.request('/api/genealogies').then(function (list) {
      const own = (list || []).find(function (g) {
        return g.kind === 'kinship' && g.owner_user_id === user.id
      })
      if (!own) return false
      if (own.id === that.data.genealogyId) return true
      wx.navigateTo({ url: '/pages/tree/tree?genealogy_id=' + own.id })
      return true
    }).catch(function (err) {
      wx.showToast({ title: (err && err.message) || '打开亲戚谱失败', icon: 'none' })
      return false
    })
  },

  onRootChange: function (e) {
    this.setData({ rootIndex: Number(e.detail.value), scrollToId: '' })
    this.loadTree()
  },

  onMaxGenChange: function (e) {
    this.setData({ maxGenIndex: Number(e.detail.value), scrollToId: '' })
    this.loadTree()
  },

  onFocusChange: function (e) {
    this.setData({ focusIndex: Number(e.detail.value), scrollToId: '' })
    this.loadTree()
  },

  onSideChange: function (e) {
    this.setData({ sideIndex: Number(e.detail.value) })
    this.loadTree()
  },

  setZoom: function (index) {
    const steps = this.data.zoomSteps
    const i = Math.max(0, Math.min(index, steps.length - 1))
    const zoom = steps[i]
    const baseW = this.baseWidth || 0
    const baseH = this.baseHeight || 0
    this.setData({
      zoomIndex: i,
      zoom: zoom,
      zoomText: Math.round(zoom * 100) + '%',
      shelfWidth: baseW ? Math.ceil(baseW * zoom) : 0,
      treeHeight: baseH ? Math.ceil(baseH * zoom) : 0
    })
  },

  // 记录未缩放时的内容尺寸，并按缩放比例撑开滚动区域
  measureTree: function () {
    const that = this
    setTimeout(function () {
      wx.createSelectorQuery().select('.tree-list').boundingClientRect(function (rect) {
        if (!rect || !rect.height) return
        const zoom = that.data.zoom || 1
        that.baseWidth = rect.width / zoom
        that.baseHeight = rect.height / zoom
        that.setData({
          baseWidth: Math.ceil(that.baseWidth),
          baseHeight: Math.ceil(that.baseHeight),
          shelfWidth: Math.ceil(that.baseWidth * zoom),
          treeHeight: Math.ceil(that.baseHeight * zoom)
        })
      }).exec()
    }, 150)
  },

  zoomOut: function () {
    this.setZoom(this.data.zoomIndex - 1)
  },

  zoomIn: function () {
    this.setZoom(this.data.zoomIndex + 1)
  },

  resetZoom: function () {
    this.setZoom(3)
  },

  loadTree: function () {
    if (this.data.mode === 'lineage') {
      this.loadLineage()
    } else {
      this.loadKinship()
    }
  },

  applyTree: function (root, focusId, hint, ancestors) {
    this.treeRoot = root
    this.treeFocusId = focusId
    this.collapseMap = {}
    const flat = flattenTree(root, focusId, this.data.myMemberId, this.collapseMap)
    this.anchorMap = flat.anchor
    const patch = {
      rows: flat.rows,
      ancestors: ancestors || [],
      loading: false,
      hint: hint
    }
    if (!this.data.located && this.data.myMemberId && flat.anchor[this.data.myMemberId]) {
      patch.located = true
      patch.scrollToId = ''
      this.setData(patch)
      this.measureTree()
      const that = this
      const key = flat.anchor[this.data.myMemberId]
      setTimeout(function () {
        that.setData({ scrollToId: 'row-' + key })
      }, 150)
      return
    }
    this.setData(patch)
    this.measureTree()
  },

  loadLineage: function () {
    if (this.data.isKinship) {
      this.loadBranch()
      return
    }
    const that = this
    const id = this.data.genealogyId
    const gen = GEN_OPTIONS[this.data.maxGenIndex]
    const rootOption = this.data.rootIndex > 0 ? this.data.members[this.data.rootIndex - 1] : null
    let url = '/api/genealogies/' + id + '/tree/lineage?max_generations=' + gen
    if (rootOption) url += '&root_id=' + rootOption.member_id
    this.setData({ loading: true })
    api.request(url).then(function (data) {
      if (!data || !data.root) {
        that.anchorMap = {}
        that.setData({ rows: [], ancestors: [], loading: false, hint: '该族谱暂无成员' })
        return
      }
      that.applyTree(
        data.root,
        data.root_id,
        data.root.name + '系 · 共 ' + data.total + ' 人 · 已展 ' + (data.depth + 1) + ' 代（上限 ' + data.generation_limit + ' 代）'
      )
    }).catch(function (err) {
      that.setData({ loading: false, rows: [] })
      api.toastError(err)
    })
  },

  switchBranch: function (event) {
    const branch = event.currentTarget.dataset.branch
    if (!branch || branch === this.data.branch) return
    this.data.located = false
    this.setData({ branch: branch, rows: [], ancestors: [] })
    this.loadBranch()
  },

  loadBranch: function () {
    const that = this
    const id = this.data.genealogyId
    const branch = this.data.branch
    const label = {
      father: '父系亲戚', mother: '母系亲戚',
      spouse: '配偶父系', spouse_father: '配偶父系', spouse_mother: '配偶母系'
    }[branch] || '亲戚'
    this.setData({ loading: true })
    api.request('/api/genealogies/' + id + '/tree/lineage?branch=' + branch)
      .then(function (data) {
        if (!data || !data.root) {
          that.anchorMap = {}
          that.setData({ rows: [], ancestors: [], loading: false, hint: '暂无' + label + '数据' })
          return
        }
        that.applyTree(
          data.root,
          data.root_id,
          label + ' · 共 ' + data.total + ' 人 · ' + data.generations + ' 级'
        )
      })
      .catch(function (err) {
        that.setData({ loading: false, rows: [] })
        api.toastError(err)
      })
  },

  loadKinship: function () {
    const that = this
    const members = this.data.members
    if (!members.length) {
      this.anchorMap = {}
      this.setData({ rows: [], ancestors: [], loading: false, hint: '该族谱暂无成员' })
      return
    }
    const focus = members[Math.min(this.data.focusIndex, members.length - 1)]
    const sides = ['father', 'mother', 'spouse_father', 'spouse_mother']
    const side = sides[this.data.sideIndex] || 'father'
    const label = {
      father: '父系亲戚', mother: '母系亲戚',
      spouse_father: '配偶父系', spouse_mother: '配偶母系'
    }[side]
    this.setData({ loading: true })
    api.request('/api/genealogies/' + this.data.genealogyId + '/tree/lineage?branch=' + side +
      '&center_id=' + focus.member_id)
      .then(function (data) {
        if (!data || !data.root) {
          that.anchorMap = {}
          that.setData({ rows: [], ancestors: [], loading: false, hint: '暂无' + label + '数据' })
          return
        }
        that.applyTree(
          data.root,
          data.root_id,
          label + ' · 共 ' + data.total + ' 人 · ' + data.generations + ' 级'
        )
      }).catch(function (err) {
        that.setData({ loading: false, rows: [], ancestors: [], hint: err.message })
        api.toastError(err)
      })
  },

  locateMe: function () {
    const key = this.anchorMap && this.anchorMap[this.data.myMemberId]
    if (!key) {
      wx.showToast({ title: '当前树中未找到您的身份', icon: 'none' })
      return
    }
    const that = this
    this.setData({ scrollToId: '' }, function () {
      setTimeout(function () {
        that.setData({ scrollToId: 'row-' + key })
      }, 80)
    })
  },

  rebuildRows: function () {
    if (!this.treeRoot) return
    const flat = flattenTree(this.treeRoot, this.treeFocusId, this.data.myMemberId, this.collapseMap || {})
    this.anchorMap = flat.anchor
    this.setData({ rows: flat.rows })
    this.measureTree()
  },

  // 点击成员卡：收起/展开其下一代；无后代时直接进入详情
  toggleNode: function (e) {
    const dataset = e.currentTarget.dataset
    const id = Number(dataset.id)
    const hasChildren = dataset.hasChildren === true || dataset.hasChildren === 'true'
    if (!id) return
    if (!hasChildren) {
      this.openDetail(id)
      return
    }
    if (!this.collapseMap) this.collapseMap = {}
    if (this.collapseMap[id]) {
      delete this.collapseMap[id]
    } else {
      this.collapseMap[id] = true
    }
    this.rebuildRows()
  },

  onNodeTap: function (e) {
    const id = Number(e.currentTarget.dataset.id)
    if (id) this.openDetail(id)
  },

  openDetail: function (id) {
    if (!this.memberIds || !this.memberIds[id]) {
      wx.showToast({ title: '该成员属于其他族谱，请到对应族谱查看', icon: 'none' })
      return
    }
    wx.navigateTo({
      url: '/pages/member-detail/member-detail?genealogy_id=' + this.data.genealogyId + '&member_id=' + id
    })
  },

  goAdd: function () {
    this.needRefresh = true
    wx.navigateTo({
      url: '/pages/member-edit/member-edit?genealogy_id=' + this.data.genealogyId + '&mode=add'
    })
  },

  goApprovals: function () {
    this.needRefresh = true
    wx.navigateTo({
      url: '/pages/approvals/approvals?genealogy_id=' + this.data.genealogyId
    })
  },

  goPermissions: function () {
    this.needRefresh = true
    wx.navigateTo({
      url: '/pages/permissions/permissions?genealogy_id=' + this.data.genealogyId
    })
  },

  goHome: function () {
    wx.switchTab({ url: '/pages/index/index' })
  },

  stop: function () {}
})
