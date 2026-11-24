const api = require('../../utils/api')

function decorate(node) {
  const spouses = (node.spouses || []).map(function (sp) {
    return Object.assign({}, sp, {
      initial: (sp.name || '?').slice(0, 1),
      genderClass: sp.gender === '女' ? 'female' : 'male'
    })
  })
  const meta = []
  if (node.generation) meta.push('第' + node.generation + '代')
  if (node.birth_year || node.death_year) {
    meta.push((node.birth_year || '?') + (node.death_year ? '—' + node.death_year : '—'))
  }
  return Object.assign({}, node, {
    initial: (node.name || '?').slice(0, 1),
    genderClass: node.gender === '女' ? 'female' : 'male',
    metaText: meta.join(' · '),
    isFocus: false,
    spouses: spouses,
    children: (node.children || []).map(decorate)
  })
}

function flatten(root) {
  const out = []
  ;(function walk(node) {
    out.push({ id: node.id, name: node.name, generation: node.generation })
    ;(node.spouses || []).forEach(function (sp) {
      out.push({ id: sp.id, name: sp.name + '（配偶）', generation: sp.generation })
    })
    ;(node.children || []).forEach(walk)
  })(root)
  return out
}

Page({
  data: {
    id: 0,
    genealogy: null,
    tree: null,
    hint: '',
    loading: true,
    isMember: false,
    pendingJoin: false,
    memberOptions: [],
    memberIndex: 0,
    submitting: false
  },

  onLoad: function (options) {
    this.setData({ id: Number(options.id || 0) })
    this.load()
  },

  load: function () {
    const that = this
    const id = this.data.id
    if (!id) return
    Promise.all([
      api.request('/api/genealogies/public'),
      api.request('/api/genealogies/' + id + '/tree/lineage')
    ]).then(function (res) {
      const item = (res[0] || []).filter(function (g) { return g.id === id })[0] || {}
      const data = res[1]
      wx.setNavigationBarTitle({ title: item.name || '公开族谱' })
      if (!data || !data.root) {
        that.setData({
          genealogy: item,
          loading: false,
          hint: '该族谱暂无成员',
          isMember: !!item.is_member,
          pendingJoin: !!item.pending_join
        })
        return
      }
      const members = flatten(data.root)
      that.setData({
        genealogy: item,
        tree: decorate(data.root),
        hint: data.root.name + '系 · 共 ' + data.total + ' 人 · ' + (data.depth + 1) + ' 代',
        memberOptions: members,
        memberIndex: 0,
        isMember: !!item.is_member,
        pendingJoin: !!item.pending_join,
        loading: false
      })
    }).catch(function (err) {
      that.setData({ loading: false })
      api.toastError(err)
    })
  },

  onMemberChange: function (e) {
    this.setData({ memberIndex: Number(e.detail.value) })
  },

  submitJoin: function () {
    const that = this
    const member = this.data.memberOptions[this.data.memberIndex]
    if (!member) {
      wx.showToast({ title: '请选择要绑定的谱成员', icon: 'none' })
      return
    }
    wx.showModal({
      title: '确认申请加入',
      content: '将申请绑定为「' + member.name + '」，提交后需管理员审批，绑定后仅管理员可更改。',
      success: function (res) {
        if (!res.confirm) return
        that.setData({ submitting: true })
        api.request('/api/genealogies/' + that.data.id + '/join', {
          method: 'POST',
          data: { member_id: member.id }
        }).then(function () {
          that.setData({ submitting: false, pendingJoin: true })
          wx.showToast({ title: '已提交，等待审批', icon: 'none' })
        }).catch(function (err) {
          that.setData({ submitting: false })
          api.toastError(err)
        })
      }
    })
  },

  enterGenealogy: function () {
    const item = this.data.genealogy || {}
    getApp().setGenealogy({ id: this.data.id, name: item.name, role: 'normal' })
    wx.navigateTo({ url: '/pages/tree/tree?genealogy_id=' + this.data.id })
  }
})
