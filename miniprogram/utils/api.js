// 接口请求封装：统一携带 token、处理错误与登录过期
const { BASE_URL } = require('../config')

function getToken() {
  return wx.getStorageSync('token') || ''
}

function clearAuth() {
  wx.removeStorageSync('token')
  wx.removeStorageSync('user')
  wx.removeStorageSync('genealogy')
  wx.removeStorageSync('genealogy_id')
  const app = getApp()
  if (app && app.globalData) {
    app.globalData.user = null
    app.globalData.genealogy = null
  }
}

function request(path, options) {
  const opts = options || {}
  return new Promise((resolve, reject) => {
    const header = Object.assign({ 'Content-Type': 'application/json' }, opts.header || {})
    const token = getToken()
    if (token) header.Authorization = 'Bearer ' + token
    wx.request({
      url: BASE_URL + path,
      method: opts.method || 'GET',
      data: opts.data,
      header: header,
      success: function (res) {
        const body = res.data || {}
        if (res.statusCode === 401) {
          clearAuth()
          wx.reLaunch({ url: '/pages/login/login' })
          reject(new Error(body.error || '登录已过期，请重新登录'))
          return
        }
        if (res.statusCode < 200 || res.statusCode >= 300 || body.ok === false) {
          reject(new Error(body.error || ('请求失败（' + res.statusCode + '）')))
          return
        }
        resolve(body.data)
      },
      fail: function (err) {
        const msg = (err && err.errMsg) || ''
        if (msg.indexOf('domain') > -1 || msg.indexOf('not in domain list') > -1) {
          reject(new Error('请求域名未配置，请在开发者工具中勾选「不校验合法域名」'))
        } else {
          reject(new Error('网络请求失败，请确认后端服务已启动'))
        }
      }
    })
  })
}

function upload(path, filePath, name) {
  return new Promise((resolve, reject) => {
    const header = {}
    const token = getToken()
    if (token) header.Authorization = 'Bearer ' + token
    wx.uploadFile({
      url: BASE_URL + path,
      filePath: filePath,
      name: name || 'photo',
      header: header,
      success: function (res) {
        let body = {}
        try { body = JSON.parse(res.data) } catch (e) { body = {} }
        if (res.statusCode === 401) {
          clearAuth()
          wx.reLaunch({ url: '/pages/login/login' })
          reject(new Error('登录已过期，请重新登录'))
          return
        }
        if (res.statusCode < 200 || res.statusCode >= 300 || body.ok === false) {
          reject(new Error(body.error || '上传失败'))
          return
        }
        resolve(body.data)
      },
      fail: function () {
        reject(new Error('上传失败，请检查网络与文件大小'))
      }
    })
  })
}

// 后端返回的照片是 /static/uploads/xxx 相对路径，展示时补全域名
function assetUrl(path) {
  if (!path) return ''
  if (/^https?:\/\//.test(path)) return path
  return BASE_URL + path
}

function toastError(err) {
  wx.showToast({ title: (err && err.message) || '操作失败', icon: 'none' })
}

module.exports = {
  request: request,
  upload: upload,
  assetUrl: assetUrl,
  toastError: toastError,
  getToken: getToken,
  clearAuth: clearAuth,
  BASE_URL: BASE_URL
}
