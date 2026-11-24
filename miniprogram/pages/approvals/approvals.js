const api = require('../../utils/api')

const ACTION_LABEL = { add_member: '新增成员', join_bind: '加入并绑定' }
const STATUS_MAP = {
  pending: { label: '待审批', cls: 'pill-pending' },
  approved: { label: '已通过', cls: 'pill-ok' },
  rejected: { label: '已驳回', cls: 'pill-err' }
}

function decorate(p) {
  const payload = p.payload || {}
  const status = STATUS_MAP[p.status] || { label: p.status, cls: 'pill' }
  return Object.assign({}, p, {
    actionLabel: ACTION_LABEL[p.action] || p.action,
    isJoin: p.action === 'join_bind',
    statusLabel: status.label,
    statusClass: status.cls,
    targetName: p.target_member_name || (payload.member_id ? '#' + payload.member_id : '未知成员'),
    proposerText: p.proposer_display || p.proposer_name || '未知',
    createdText: (p.created_at || '').slice(0, 16),
    genderText: payload.gender || '',
    generationText: payload.generation ? '第' + payload.generation + '代' : '',
    birthText: payload.birth_year ? payload.birth_year + ' 年' : '',
    hometownText: payload.hometown || ''
  })
}

Page({
  data: {
    genealogyId: 0,
    role: 'normal',
    isAdmin: false,
    filter: 'pending',
    list: [],
    loading: true,
    pendingCount: 0
  },

  onLoad: function (options) {
    this.setData({
      genealogyId: Number(options.genealogy_id || wx.getStorageSync('genealogy_id') || 0)
    })
    this.load()
  },

  onShow: function () {
    if (this.loadedOnce) this.load()
  },

  load: function () {
    const that = this
    Promise.all([
      api.request('/api/genealogies/' + this.data.genealogyId + '/proposals'),
      api.request('/api/genealogies/' + this.data.genealogyId)
    ]).then(function (res) {
      const list = (res[0] || []).map(decorate)
      const role = (res[1] || {}).role || 'normal'
      that.loadedOnce = true
      that.setData({
        list: list,
        role: role,
        isAdmin: role === 'admin',
        loading: false,
        pendingCount: list.filter(function (p) { return p.status === 'pending' }).length
      })
    }).catch(function (err) {
      that.setData({ loading: false })
      api.toastError(err)
    })
  },

  switchFilter: function (e) {
    this.setData({ filter: e.currentTarget.dataset.filter })
  },

  approve: function (e) {
    const that = this
    const pid = Number(e.currentTarget.dataset.pid)
    const target = this.data.list.filter(function (p) { return p.id === pid })[0]
    const content = target && target.isJoin
      ? '同意后该用户将加入本谱并绑定「' + target.targetName + '」'
      : '同意后将按申请内容创建成员'
    wx.showModal({
      title: '确认同意',
      content: content,
      success: function (res) {
        if (!res.confirm) return
        wx.showLoading({ title: '处理中', mask: true })
        api.request('/api/genealogies/' + that.data.genealogyId + '/proposals/' + pid + '/approve', {
          method: 'POST'
        }).then(function () {
          wx.hideLoading()
          wx.showToast({ title: '已同意', icon: 'success' })
          that.load()
        }).catch(function (err) {
          wx.hideLoading()
          api.toastError(err)
          that.load()
        })
      }
    })
  },

  reject: function (e) {
    const that = this
    const pid = Number(e.currentTarget.dataset.pid)
    wx.showModal({
      title: '驳回申请',
      editable: true,
      placeholderText: '驳回原因（可选）',
      success: function (res) {
        if (!res.confirm) return
        wx.showLoading({ title: '处理中', mask: true })
        api.request('/api/genealogies/' + that.data.genealogyId + '/proposals/' + pid + '/reject', {
          method: 'POST',
          data: { reason: res.content || '' }
        }).then(function () {
          wx.hideLoading()
          wx.showToast({ title: '已驳回', icon: 'none' })
          that.load()
        }).catch(function (err) {
          wx.hideLoading()
          api.toastError(err)
        })
      }
    })
  }
})
