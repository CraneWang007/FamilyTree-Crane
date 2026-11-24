const api = require('../../utils/api')

function decorate(m) {
  const meta = []
  if (m.generation) meta.push('第' + m.generation + '代')
  if (m.gender) meta.push(m.gender)
  if (m.sibling_rank) meta.push('排行 ' + m.sibling_rank)
  const life = []
  if (m.birth_year) life.push(m.birth_year + ' 年生')
  if (m.death_year) life.push(m.death_year + ' 年卒')
  return Object.assign({}, m, {
    initial: (m.name || '?').slice(0, 1),
    genderClass: m.gender === '女' ? 'female' : 'male',
    metaText: meta.join(' · '),
    lifeText: life.join(' · '),
    birthdayText: m.birthday_text || m.birthday || ''
  })
}

Page({
  data: {
    genealogyId: 0,
    memberId: 0,
    member: null,
    photoUrl: '',
    loading: true,
    isAdmin: false,
    canEdit: false,
    canAdd: false,
    notFound: false
  },

  onLoad: function (options) {
    this.setData({
      genealogyId: Number(options.genealogy_id || wx.getStorageSync('genealogy_id') || 0),
      memberId: Number(options.member_id || 0)
    })
    this.load()
  },

  onShow: function () {
    if (this.loadedOnce) this.load()
  },

  load: function () {
    const that = this
    const gid = this.data.genealogyId
    const mid = this.data.memberId
    if (!gid || !mid) {
      this.setData({ loading: false, notFound: true })
      return
    }
    Promise.all([
      api.request('/api/genealogies/' + gid + '/members/' + mid),
      api.request('/api/genealogies/' + gid)
    ]).then(function (res) {
      const genealogy = res[1] || {}
      const role = genealogy.role || 'normal'
      that.loadedOnce = true
      that.setData({
        member: decorate(res[0] || {}),
        photoUrl: api.assetUrl((res[0] || {}).photo),
        isAdmin: role === 'admin',
        canEdit: !!(res[0] || {}).can_edit,
        canAdd: role === 'admin' || role === 'branch_admin',
        loading: false
      })
      wx.setNavigationBarTitle({ title: (res[0] || {}).name || '成员详情' })
    }).catch(function (err) {
      that.setData({ loading: false, notFound: true })
      api.toastError(err)
    })
  },

  goMember: function (e) {
    const id = Number(e.currentTarget.dataset.id)
    if (!id) return
    wx.navigateTo({
      url: '/pages/member-detail/member-detail?genealogy_id=' + this.data.genealogyId + '&member_id=' + id
    })
  },

  goEdit: function () {
    wx.navigateTo({
      url: '/pages/member-edit/member-edit?genealogy_id=' + this.data.genealogyId +
        '&member_id=' + this.data.memberId + '&mode=edit'
    })
  },

  goAddChild: function () {
    const m = this.data.member || {}
    const key = m.gender === '女' ? 'mother_id' : 'father_id'
    wx.navigateTo({
      url: '/pages/member-edit/member-edit?genealogy_id=' + this.data.genealogyId +
        '&mode=add&' + key + '=' + this.data.memberId
    })
  },

  goAddSpouse: function () {
    wx.navigateTo({
      url: '/pages/member-edit/member-edit?genealogy_id=' + this.data.genealogyId +
        '&mode=add&spouse_id=' + this.data.memberId
    })
  },

  removeMember: function () {
    const that = this
    const m = this.data.member || {}
    wx.showModal({
      title: '删除成员',
      content: '确定删除「' + (m.name || '') + '」吗？该成员的关系会被一并移除。',
      confirmColor: '#ae3b2d',
      success: function (res) {
        if (!res.confirm) return
        api.request('/api/genealogies/' + that.data.genealogyId + '/members/' + that.data.memberId, {
          method: 'DELETE'
        }).then(function () {
          wx.showToast({ title: '已删除', icon: 'none' })
          setTimeout(function () { wx.navigateBack() }, 500)
        }).catch(api.toastError)
      }
    })
  },

  previewPhoto: function () {
    if (!this.data.photoUrl) return
    wx.previewImage({ urls: [this.data.photoUrl] })
  }
})
