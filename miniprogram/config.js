// 后端服务地址：按小程序运行环境切换
// - develop：开发者工具/真机调试，使用电脑的局域网地址（需勾选「不校验合法域名」）
// - trial / release：必须改为已备案的 HTTPS 域名，并加入小程序「服务器域名」白名单
const BASE_URLS = {
  develop: 'http://192.168.0.49:5000',
  trial: 'https://your-domain.example.com',
  release: 'https://your-domain.example.com'
}

function resolveBaseUrl() {
  let env = 'develop'
  try {
    const info = wx.getAccountInfoSync()
    env = (info && info.miniProgram && info.miniProgram.envVersion) || 'develop'
  } catch (err) {
    env = 'develop'
  }
  return BASE_URLS[env] || BASE_URLS.develop
}

module.exports = {
  BASE_URL: resolveBaseUrl()
}
