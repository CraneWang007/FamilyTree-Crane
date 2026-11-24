const api = require('../../utils/api')

const ROLE_LABEL = { admin: '管理员', branch_admin: '分支管理员', normal: '成员' }
const ROLE_CLASS = { admin: 'pill-admin', branch_admin: 'pill-branch', normal: 'pill-normal' }
const EDIT_ROLES = ['normal', 'branch_admin']
const EDIT_ROLE_LABELS = ['普通成员', '分支管理员']

Page({
  data: {
    genealogyId: 0,
    genealogy: null,
    isKinship: false,
    role: 'normal',
    isAdmin: false,
    users: [],
    memberOptions: [{ id: 0, label: '未绑定' }],
    editRoleLabels: EDIT_ROLE_LABELS,
    loading: true,

    showAdd: false,
    addUsername: '',
    addRoleIndex: 0,
    submitting: false,

    showTransfer: false,
    transferOptions: [],
    transferIndex: 0
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
    const gid = this.data.genealogyId
    Promise.all([
      api.request('/api/genealogies/' + gid + '/users'),
      api.request('/api/genealogies/' + gid + '/members'),
      api.request('/api/genealogies/' + gid)
    ]).then(function (res) {
      const rawUsers = res[0] || []
      const members = res[1] || []
      const genealogy = res[2] || {}
      const role = genealogy.role || 'normal'
      const memberOptions = [{ id: 0, label: '未绑定' }].concat(members.map(function (m) {
        return { id: m.member_id, label: '第' + (m.generation || 1) + '代 · ' + m.name }
      }))
      const users = rawUsers.map(function (u) {
        let memberIndex = 0
        for (let i = 1; i < memberOptions.length; i++) {
          if (memberOptions[i].id === u.member_id) { memberIndex = i; break }
        }
        return Object.assign({}, u, {
          roleLabel: ROLE_LABEL[u.role] || u.role,
          roleClass: ROLE_CLASS[u.role] || 'pill',
          roleIndex: Math.max(0, EDIT_ROLES.indexOf(u.role)),
          memberIndex: memberIndex,
          memberLabel: u.member_name || '未绑定'
        })
      })
      const transferOptions = users.filter(function (u) { return u.role !== 'admin' })
      that.loadedOnce = true
      that.setData({
        genealogy: genealogy,
        isKinship: genealogy.kind === 'kinship',
        role: role,
        isAdmin: role === 'admin',
        users: users,
        memberOptions: memberOptions,
        loading: false,
        transferOptions: transferOptions,
        transferIndex: 0
      })
    }).catch(function (err) {
      that.setData({ loading: false })
      api.toastError(err)
    })
  },

  onRoleChange: function (e) {
    const that = this
    const uid = Number(e.currentTarget.dataset.uid)
    const role = EDIT_ROLES[Number(e.detail.value)]
    api.request('/api/genealogies/' + this.data.genealogyId + '/users/' + uid, {
      method: 'PUT',
      data: { role: role }
    }).then(function () {
      wx.showToast({ title: '角色已更新', icon: 'none' })
      that.load()
    }).catch(function (err) {
      api.toastError(err)
      that.load()
    })
  },

  onMemberChange: function (e) {
    const that = this
    const uid = Number(e.currentTarget.dataset.uid)
    const option = this.data.memberOptions[Number(e.detail.value)]
    const memberId = option && option.id ? option.id : null
    api.request('/api/genealogies/' + this.data.genealogyId + '/users/' + uid, {
      method: 'PUT',
      data: { member_id: memberId }
    }).then(function () {
      wx.showToast({ title: memberId ? '已绑定谱成员' : '已解除绑定', icon: 'none' })
      that.load()
    }).catch(function (err) {
      api.toastError(err)
      that.load()
    })
  },

  removeUser: function (e) {
    const that = this
    const uid = Number(e.currentTarget.dataset.uid)
    const name = e.currentTarget.dataset.name || '该用户'
    wx.showModal({
      title: '移除协作者',
      content: '确定将「' + name + '」移出本族谱吗？',
      confirmColor: '#ae3b2d',
      success: function (res) {
        if (!res.confirm) return
        api.request('/api/genealogies/' + that.data.genealogyId + '/users/' + uid, {
          method: 'DELETE'
        }).then(function () {
          wx.showToast({ title: '已移除', icon: 'none' })
          that.load()
        }).catch(api.toastError)
      }
    })
  },

  openAdd: function () {
    this.setData({ showAdd: true, addUsername: '', addRoleIndex: 0 })
  },

  closeAdd: function () {
    this.setData({ showAdd: false })
  },

  onAddUsername: function (e) {
    this.setData({ addUsername: e.detail.value })
  },

  onAddRoleChange: function (e) {
    this.setData({ addRoleIndex: Number(e.detail.value) })
  },

  addUser: function () {
    const that = this
    const username = (this.data.addUsername || '').trim()
    if (!username) {
      wx.showToast({ title: '请填写用户名', icon: 'none' })
      return
    }
    this.setData({ submitting: true })
    api.request('/api/genealogies/' + this.data.genealogyId + '/users', {
      method: 'POST',
      data: { username: username, role: EDIT_ROLES[this.data.addRoleIndex] }
    }).then(function () {
      that.setData({ showAdd: false, submitting: false })
      wx.showToast({ title: '已添加协作者', icon: 'success' })
      that.load()
    }).catch(function (err) {
      that.setData({ submitting: false })
      api.toastError(err)
    })
  },

  openTransfer: function () {
    if (!this.data.transferOptions.length) {
      wx.showToast({ title: '暂无可转让的协作者', icon: 'none' })
      return
    }
    this.setData({ showTransfer: true, transferIndex: 0 })
  },

  closeTransfer: function () {
    this.setData({ showTransfer: false })
  },

  onTransferChange: function (e) {
    this.setData({ transferIndex: Number(e.detail.value) })
  },

  confirmTransfer: function () {
    const that = this
    const target = this.data.transferOptions[this.data.transferIndex]
    if (!target) return
    wx.showModal({
      title: '转让管理员',
      content: '转让后你将变为普通成员，确定转给「' + (target.display_name || target.username) + '」吗？',
      confirmColor: '#ae3b2d',
      success: function (res) {
        if (!res.confirm) return
        api.request('/api/genealogies/' + that.data.genealogyId + '/transfer', {
          method: 'POST',
          data: { new_admin_id: target.user_id }
        }).then(function () {
          that.setData({ showTransfer: false })
          wx.showToast({ title: '已转让管理员', icon: 'none' })
          that.load()
        }).catch(api.toastError)
      }
    })
  },

  stop: function () {}
})
