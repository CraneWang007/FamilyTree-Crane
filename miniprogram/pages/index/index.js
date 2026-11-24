const api = require('../../utils/api')

const ROLE_LABEL = { admin: '管理员', branch_admin: '分支管理员', normal: '成员' }

function decorate(g) {
  const visibility = g.visibility || 'private'
  const isKinship = g.kind === 'kinship'
  const isDefault = !!g.is_default
  return Object.assign({}, g, {
    roleLabel: ROLE_LABEL[g.role] || '访客',
    roleClass: g.role === 'admin' ? 'pill-admin' : g.role === 'branch_admin' ? 'pill-branch' : 'pill-normal',
    isAdmin: g.role === 'admin',
    isKinship: isKinship,
    isDefault: isDefault,
    // 默认谱：任何登录用户免加入即可只读查看
    canEnter: !!g.is_member || isDefault,
    isPublic: visibility === 'public',
    visibilityText: isKinship ? '仅本人与管理员可见' : (isDefault ? '默认指引' : (visibility === 'public' ? '公开谱' : '私密谱')),
    nextVisibility: visibility === 'public' ? 'private' : 'public',
    createdText: (g.created_at || '').slice(0, 10),
    actionText: g.is_member
      ? (isKinship ? '进入亲戚谱' : '进入族谱')
      : (isDefault ? '进入查看' : (g.pending_join ? '申请待审批' : '查看并申请加入'))
  })
}

Page({
  data: {
    user: null,
    myList: [],
    publicList: [],
    loading: true,
    showCreate: false,
    newName: '',
    newDesc: '',
    submitting: false
  },

  onShow: function () {
    if (!api.getToken()) {
      wx.reLaunch({ url: '/pages/login/login' })
      return
    }
    this.setData({ user: wx.getStorageSync('user') || null })
    this.loadAll()
  },

  loadAll: function () {
    const that = this
    Promise.all([
      api.request('/api/genealogies'),
      api.request('/api/genealogies/public')
    ]).then(function (res) {
      that.setData({
        myList: (res[0] || []).map(decorate),
        publicList: (res[1] || []).map(decorate),
        loading: false
      })
    }).catch(function (err) {
      that.setData({ loading: false })
      api.toastError(err)
    })
  },

  enterGenealogy: function (e) {
    const id = Number(e.currentTarget.dataset.id)
    const list = this.data.myList.concat(this.data.publicList)
    const target = list.filter(function (g) { return g.id === id })[0]
    if (!target) return
    getApp().setGenealogy(target)
    wx.navigateTo({ url: '/pages/tree/tree?genealogy_id=' + id })
  },

  openPublic: function (e) {
    const id = Number(e.currentTarget.dataset.id)
    const target = this.data.publicList.filter(function (g) { return g.id === id })[0]
    if (!target) return
    // 成员或默认谱：免加入直接进入树页（只读由后端权限保证）
    if (target.canEnter) {
      this.enterGenealogy(e)
      return
    }
    wx.navigateTo({ url: '/pages/public-detail/public-detail?id=' + id })
  },

  toggleVisibility: function (e) {
    const that = this
    const id = Number(e.currentTarget.dataset.id)
    const next = e.currentTarget.dataset.next
    wx.showLoading({ title: '处理中', mask: true })
    api.request('/api/genealogies/' + id + '/visibility', {
      method: 'PUT',
      data: { visibility: next }
    }).then(function () {
      wx.hideLoading()
      wx.showToast({ title: next === 'public' ? '已设为公开谱' : '已设为私密谱', icon: 'none' })
      that.loadAll()
    }).catch(function (err) {
      wx.hideLoading()
      api.toastError(err)
    })
  },

  openCreate: function () {
    this.setData({ showCreate: true, newName: '', newDesc: '' })
  },

  closeCreate: function () {
    this.setData({ showCreate: false })
  },

  onCreateInput: function (e) {
    const data = {}
    data[e.currentTarget.dataset.field] = e.detail.value
    this.setData(data)
  },

  createGenealogy: function () {
    const that = this
    const name = (this.data.newName || '').trim()
    if (!name) {
      wx.showToast({ title: '请填写族谱名称', icon: 'none' })
      return
    }
    this.setData({ submitting: true })
    api.request('/api/genealogies', {
      method: 'POST',
      data: { name: name, description: (this.data.newDesc || '').trim() }
    }).then(function (data) {
      that.setData({ showCreate: false, submitting: false })
      wx.showToast({ title: '创建成功', icon: 'success' })
      if (data && data.id) {
        getApp().setGenealogy({ id: data.id, name: name, role: 'admin' })
        wx.navigateTo({ url: '/pages/tree/tree?genealogy_id=' + data.id })
      } else {
        that.loadAll()
      }
    }).catch(function (err) {
      that.setData({ submitting: false })
      api.toastError(err)
    })
  },

  stop: function () {}
})
