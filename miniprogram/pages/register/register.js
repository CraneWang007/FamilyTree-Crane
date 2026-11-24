const api = require('../../utils/api')

Page({
  data: {
    username: '',
    password: '',
    password2: '',
    display_name: '',
    loading: false
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
    if (username.length < 2 || username.length > 32) {
      wx.showToast({ title: '用户名需 2—32 个字符', icon: 'none' })
      return
    }
    if (password.length < 6) {
      wx.showToast({ title: '密码至少 6 位', icon: 'none' })
      return
    }
    if (password !== this.data.password2) {
      wx.showToast({ title: '两次输入的密码不一致', icon: 'none' })
      return
    }
    this.setData({ loading: true })
    api.request('/api/auth/register', {
      method: 'POST',
      data: {
        username: username,
        password: password,
        display_name: (this.data.display_name || '').trim()
      }
    }).then(function () {
      return api.request('/api/auth/login', {
        method: 'POST',
        data: { username: username, password: password }
      })
    }).then(function (data) {
      getApp().setAuth(data.token, data.user)
      wx.showToast({ title: '注册成功', icon: 'success' })
      setTimeout(function () {
        wx.switchTab({ url: '/pages/index/index' })
      }, 500)
    }).catch(function (err) {
      wx.showToast({ title: err.message, icon: 'none' })
      that.setData({ loading: false })
    })
  }
})
