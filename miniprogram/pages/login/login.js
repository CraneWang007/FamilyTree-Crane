const api = require('../../utils/api')

Page({
  data: {
    username: '',
    password: '',
    loading: false
  },

  onShow: function () {
    if (api.getToken()) {
      wx.switchTab({ url: '/pages/index/index' })
    }
  },

  onInput: function (e) {
    const field = e.currentTarget.dataset.field
    const data = {}
    data[field] = e.detail.value
    this.setData(data)
  },

  submit: function () {
    const that = this
    const username = (this.data.username || '').trim()
    const password = this.data.password || ''
    if (!username || !password) {
      wx.showToast({ title: '请填写用户名与密码', icon: 'none' })
      return
    }
    this.setData({ loading: true })
    api.request('/api/auth/login', {
      method: 'POST',
      data: { username: username, password: password }
    }).then(function (data) {
      that.afterLogin(data)
    }).catch(function (err) {
      wx.showToast({ title: err.message, icon: 'none' })
    }).then(function () {
      that.setData({ loading: false })
    })
  },

  // 微信一键登录：wx.login 拿 code，后端换取 openid 并自动建档
  wechatLogin: function () {
    const that = this
    this.setData({ loading: true })
    wx.login({
      success: function (res) {
        if (!res.code) {
          wx.showToast({ title: '获取微信登录凭证失败', icon: 'none' })
          that.setData({ loading: false })
          return
        }
        api.request('/api/auth/wechat/login', {
          method: 'POST',
          data: { code: res.code }
        }).then(function (data) {
          that.afterLogin(data)
        }).catch(function (err) {
          wx.showToast({ title: err.message, icon: 'none' })
          that.setData({ loading: false })
        })
      },
      fail: function () {
        wx.showToast({ title: '微信登录失败', icon: 'none' })
        that.setData({ loading: false })
      }
    })
  },

  afterLogin: function (data) {
    const app = getApp()
    app.setAuth(data.token, data.user)
    this.setData({ loading: false })
    wx.switchTab({ url: '/pages/index/index' })
  },

  goRegister: function () {
    wx.navigateTo({ url: '/pages/register/register' })
  }
})
