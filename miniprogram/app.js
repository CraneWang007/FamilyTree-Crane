// 家和万事兴 · 家谱小程序
const config = require('./config')

App({
  globalData: {
    baseUrl: config.BASE_URL,
    user: null,
    genealogy: null
  },

  onLaunch: function () {
    this.restoreSession()
  },

  restoreSession: function () {
    this.globalData.user = wx.getStorageSync('user') || null
    this.globalData.genealogy = wx.getStorageSync('genealogy') || null
  },

  setAuth: function (token, user) {
    wx.setStorageSync('token', token)
    wx.setStorageSync('user', user || null)
    this.globalData.user = user || null
  },

  setGenealogy: function (genealogy) {
    wx.setStorageSync('genealogy', genealogy || null)
    wx.setStorageSync('genealogy_id', genealogy ? genealogy.id : '')
    this.globalData.genealogy = genealogy || null
  },

  clearAuth: function () {
    wx.removeStorageSync('token')
    wx.removeStorageSync('user')
    wx.removeStorageSync('genealogy')
    wx.removeStorageSync('genealogy_id')
    this.globalData.user = null
    this.globalData.genealogy = null
  },

  // 计算属相（与后端保持一致，用于表单本地预览）
  zodiacOfYear: function (year) {
    const zodiacs = ['鼠', '牛', '虎', '兔', '龙', '蛇', '马', '羊', '猴', '鸡', '狗', '猪']
    if (!year) return ''
    return zodiacs[((year - 1900) % 12 + 12) % 12]
  }
})
