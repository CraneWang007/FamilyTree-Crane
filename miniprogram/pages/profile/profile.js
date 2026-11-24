const api = require('../../utils/api')

Page({
  data: {
    user: null,
    loading: true,
    baseUrl: api.BASE_URL,

    genealogies: [],
    showBind: false,
    bindTarget: null,
    bindMembers: [],
    bindFiltered: [],
    bindKeyword: '',
    bindMemberId: 0,
    bindMemberName: '',
    binding: false,
    loadingMembers: false
  },

  onShow: function () {
    if (!api.getToken()) {
      wx.reLaunch({ url: '/pages/login/login' })
      return
    }
    this.loadMe()
    this.loadGenealogies()
  },

  loadMe: function () {
    const that = this
    api.request('/api/auth/me').then(function (data) {
      const user = (data && data.user) || data || {}
      wx.setStorageSync('user', user)
      that.setData({
        user: user,
        loading: false,
        initial: (user.display_name || user.username || '我').slice(0, 1)
      })
    }).catch(function (err) {
      that.setData({ loading: false })
      api.toastError(err)
    })
  },

  loadGenealogies: function () {
    const that = this
    api.request('/api/genealogies').then(function (list) {
      // 亲戚谱是派生数据，身份绑定只在源家谱中进行
      const families = (list || []).filter(function (g) { return g.kind !== 'kinship' })
      that.setData({ genealogies: families })
    }).catch(function () {})
  },

  openBind: function (e) {
    const gid = Number(e.currentTarget.dataset.id)
    const target = (this.data.genealogies || []).filter(function (g) { return g.id === gid })[0]
    if (!target) return
    if (target.member_id) {
      wx.showModal({
        title: '已绑定身份',
        content: '当前已绑定「第' + (target.member_generation || 1) + '代 · ' + (target.member_name || '') + '」，如需更改请联系管理员。',
        showCancel: false
      })
      return
    }
    const that = this
    this.setData({ loadingMembers: true })
    api.request('/api/genealogies/' + gid + '/members').then(function (list) {
      const members = (list || []).slice().sort(function (a, b) {
        return (a.generation || 1) - (b.generation || 1) || a.member_id - b.member_id
      }).map(function (m) {
        return {
          id: m.member_id,
          name: m.name,
          generation: m.generation,
          label: '第' + (m.generation || 1) + '代 · ' + m.name,
          active: false
        }
      })
      that.setData({
        showBind: true,
        bindTarget: target,
        bindMembers: members,
        bindFiltered: members,
        bindKeyword: '',
        bindMemberId: 0,
        bindMemberName: '',
        loadingMembers: false
      })
    }).catch(function (err) {
      that.setData({ loadingMembers: false })
      api.toastError(err)
    })
  },

  onBindSearch: function (e) {
    const keyword = (e.detail.value || '').trim()
    const selected = this.data.bindMemberId
    const filtered = (this.data.bindMembers || []).filter(function (m) {
      return !keyword || m.name.indexOf(keyword) > -1
    }).map(function (m) {
      return Object.assign({}, m, { active: m.id === selected })
    })
    this.setData({ bindKeyword: keyword, bindFiltered: filtered })
  },

  chooseMember: function (e) {
    const id = Number(e.currentTarget.dataset.id)
    const target = (this.data.bindMembers || []).filter(function (m) { return m.id === id })[0]
    if (!target) return
    const filtered = this.data.bindFiltered.map(function (m) {
      return Object.assign({}, m, { active: m.id === id })
    })
    this.setData({ bindMemberId: id, bindMemberName: target.name, bindFiltered: filtered })
  },

  closeBind: function () {
    this.setData({ showBind: false, bindTarget: null, bindMembers: [], bindFiltered: [], bindKeyword: '', bindMemberId: 0 })
  },

  confirmBind: function () {
    const that = this
    if (!this.data.bindMemberId) {
      wx.showToast({ title: '请选择要绑定的成员', icon: 'none' })
      return
    }
    const target = this.data.bindTarget || {}
    this.setData({ binding: true })
    api.request('/api/genealogies/' + target.id + '/bind-member', {
      method: 'POST',
      data: { member_id: this.data.bindMemberId }
    }).then(function () {
      that.setData({ binding: false })
      that.closeBind()
      wx.showToast({ title: '身份绑定成功', icon: 'success' })
      that.loadGenealogies()
    }).catch(function (err) {
      that.setData({ binding: false })
      api.toastError(err)
    })
  },

  bindWechat: function () {
    const that = this
    wx.login({
      success: function (res) {
        if (!res.code) {
          wx.showToast({ title: '获取微信凭证失败', icon: 'none' })
          return
        }
        api.request('/api/auth/wechat/bind', {
          method: 'POST',
          data: { code: res.code }
        }).then(function (data) {
          const user = Object.assign({}, that.data.user || {}, { wechat_bound: true })
          wx.setStorageSync('user', user)
          that.setData({ user: user })
          wx.showToast({ title: '微信已绑定', icon: 'success' })
        }).catch(function (err) {
          if (err.message && err.message.indexOf('已绑定其他账号') > -1) {
            wx.showModal({
              title: '无法绑定',
              content: '该微信已绑定其他账号，请使用微信一键登录原账号。',
              showCancel: false
            })
            return
          }
          api.toastError(err)
        })
      },
      fail: function () {
        wx.showToast({ title: '微信登录失败', icon: 'none' })
      }
    })
  },

  goHome: function () {
    wx.switchTab({ url: '/pages/index/index' })
  },

  logout: function () {
    wx.showModal({
      title: '退出登录',
      content: '确定退出当前账号吗？',
      confirmColor: '#ae3b2d',
      success: function (res) {
        if (!res.confirm) return
        api.request('/api/auth/logout', { method: 'POST' }).catch(function () {})
          .then(function () {
            api.clearAuth()
            getApp().clearAuth()
            wx.reLaunch({ url: '/pages/login/login' })
          })
      }
    })
  },

  stop: function () {}
})
