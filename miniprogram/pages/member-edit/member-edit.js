const api = require('../../utils/api')

const GENDERS = ['男', '女']
const REL_TYPES = ['血缘', '配偶', '收养', '过继']
const BIRTHDAY_LABELS = ['公历', '农历']
const BIRTHDAY_VALUES = ['solar', 'lunar']

function numOrNull(v) {
  if (v === '' || v === null || v === undefined) return null
  const n = Number(v)
  return isNaN(n) ? null : n
}

Page({
  data: {
    genealogyId: 0,
    memberId: 0,
    mode: 'add',
    role: 'normal',
    isAdmin: false,
    personalOnly: false,

    genders: GENDERS,
    genderIndex: 0,
    relTypes: REL_TYPES,
    relIndex: 0,
    birthdayLabels: BIRTHDAY_LABELS,
    birthdayTypeIndex: 0,

    form: {
      name: '',
      code: '',
      generation: '',
      sibling_rank: '',
      birth_year: '',
      death_year: '',
      birthday: '',
      hometown: '',
      residence: '',
      contact: ''
    },

    parentOptions: [{ id: 0, label: '不选择' }],
    fatherIndex: 0,
    motherIndex: 0,
    spouseOptions: [],
    spouseIds: [],

    photoPath: '',
    photoUrl: '',
    submitting: false
  },

  onLoad: function (options) {
    const gid = Number(options.genealogy_id || wx.getStorageSync('genealogy_id') || 0)
    const mode = options.mode === 'edit' ? 'edit' : 'add'
    const memberId = Number(options.member_id || 0)
    this.prefill = {
      father_id: Number(options.father_id || 0),
      mother_id: Number(options.mother_id || 0),
      spouse_id: Number(options.spouse_id || 0)
    }
    this.setData({ genealogyId: gid, mode: mode, memberId: memberId })
    wx.setNavigationBarTitle({ title: mode === 'edit' ? '编辑成员' : '新增成员' })
    this.loadAll()
  },

  loadAll: function () {
    const that = this
    const gid = this.data.genealogyId
    const tasks = [
      api.request('/api/genealogies/' + gid + '/members'),
      api.request('/api/genealogies/' + gid)
    ]
    if (this.data.mode === 'edit' && this.data.memberId) {
      tasks.push(api.request('/api/genealogies/' + gid + '/members/' + this.data.memberId))
    }
    Promise.all(tasks).then(function (res) {
      const members = res[0] || []
      const genealogy = res[1] || {}
      const role = genealogy.role || 'normal'
      const selfId = that.data.mode === 'edit' ? that.data.memberId : 0
      const options = [{ id: 0, label: '不选择' }].concat(
        members.filter(function (m) { return m.member_id !== selfId }).map(function (m) {
          return { id: m.member_id, label: '第' + (m.generation || 1) + '代 · ' + m.name }
        })
      )
      const spouseOptions = members.filter(function (m) { return m.member_id !== selfId }).map(function (m) {
        return {
          id: m.member_id,
          label: '第' + (m.generation || 1) + '代 · ' + m.name + (m.gender ? '（' + m.gender + '）' : ''),
          checked: false
        }
      })
      that.setData({
        role: role,
        isAdmin: role === 'admin',
        personalOnly: role === 'normal' && that.data.mode === 'edit',
        parentOptions: options,
        spouseOptions: spouseOptions
      })

      if (that.data.mode === 'edit' && res[2]) {
        that.fillForm(res[2], options, spouseOptions)
      } else {
        that.applyPrefill(options, spouseOptions)
      }
    }).catch(api.toastError)
  },

  fillForm: function (m, options, spouseOptions) {
    const genderIndex = GENDERS.indexOf(m.gender) > -1 ? GENDERS.indexOf(m.gender) : 0
    const relIndex = REL_TYPES.indexOf(m.relation_type) > -1 ? REL_TYPES.indexOf(m.relation_type) : 0
    const birthdayTypeIndex = BIRTHDAY_VALUES.indexOf(m.birthday_type) > -1 ? BIRTHDAY_VALUES.indexOf(m.birthday_type) : 0
    const spouseIds = (m.spouse_ids || []).map(Number)
    const fatherIndex = this.indexById(options, m.father_id)
    const motherIndex = this.indexById(options, m.mother_id)
    const optionsWithCheck = spouseOptions.map(function (o) {
      return Object.assign({}, o, { checked: spouseIds.indexOf(o.id) > -1 })
    })
    this.setData({
      form: {
        name: m.name || '',
        code: m.code && String(m.code).indexOf('pending') !== 0 ? m.code : '',
        generation: m.generation ? String(m.generation) : '',
        sibling_rank: m.sibling_rank ? String(m.sibling_rank) : '',
        birth_year: m.birth_year ? String(m.birth_year) : '',
        death_year: m.death_year ? String(m.death_year) : '',
        birthday: m.birthday || '',
        hometown: m.hometown || '',
        residence: m.residence || '',
        contact: m.contact || ''
      },
      genderIndex: genderIndex,
      relIndex: relIndex,
      birthdayTypeIndex: birthdayTypeIndex,
      fatherIndex: fatherIndex,
      motherIndex: motherIndex,
      spouseOptions: optionsWithCheck,
      spouseIds: spouseIds,
      photoUrl: api.assetUrl(m.photo)
    })
  },

  applyPrefill: function (options, spouseOptions) {
    const prefill = this.prefill || {}
    const spouseIds = prefill.spouse_id ? [prefill.spouse_id] : []
    this.setData({
      fatherIndex: this.indexById(options, prefill.father_id),
      motherIndex: this.indexById(options, prefill.mother_id),
      relIndex: prefill.spouse_id ? 1 : 0,
      spouseOptions: spouseOptions.map(function (o) {
        return Object.assign({}, o, { checked: spouseIds.indexOf(o.id) > -1 })
      }),
      spouseIds: spouseIds
    })
  },

  indexById: function (options, id) {
    const target = Number(id || 0)
    for (let i = 0; i < options.length; i++) {
      if (options[i].id === target) return i
    }
    return 0
  },

  onField: function (e) {
    const field = e.currentTarget.dataset.field
    const form = Object.assign({}, this.data.form)
    form[field] = e.detail.value
    this.setData({ form: form })
  },

  onGenderChange: function (e) {
    this.setData({ genderIndex: Number(e.detail.value) })
  },

  onRelChange: function (e) {
    this.setData({ relIndex: Number(e.detail.value) })
  },

  onBirthdayTypeChange: function (e) {
    this.setData({ birthdayTypeIndex: Number(e.detail.value) })
  },

  onBirthdayChange: function (e) {
    const form = Object.assign({}, this.data.form)
    form.birthday = e.detail.value
    this.setData({ form: form })
  },

  clearBirthday: function () {
    const form = Object.assign({}, this.data.form)
    form.birthday = ''
    this.setData({ form: form })
  },

  onFatherChange: function (e) {
    this.setData({ fatherIndex: Number(e.detail.value) })
  },

  onMotherChange: function (e) {
    this.setData({ motherIndex: Number(e.detail.value) })
  },

  onSpouseChange: function (e) {
    const ids = (e.detail.value || []).map(Number)
    const options = this.data.spouseOptions.map(function (o) {
      return Object.assign({}, o, { checked: ids.indexOf(o.id) > -1 })
    })
    this.setData({ spouseIds: ids, spouseOptions: options })
  },

  choosePhoto: function () {
    const that = this
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sizeType: ['compressed'],
      success: function (res) {
        const file = res.tempFiles && res.tempFiles[0]
        if (file) that.setData({ photoPath: file.tempFilePath })
      }
    })
  },

  buildPayload: function () {
    const form = this.data.form
    const personal = {
      name: (form.name || '').trim(),
      gender: GENDERS[this.data.genderIndex],
      birth_year: numOrNull(form.birth_year),
      death_year: numOrNull(form.death_year),
      birthday: form.birthday || '',
      birthday_type: form.birthday ? BIRTHDAY_VALUES[this.data.birthdayTypeIndex] : '',
      hometown: (form.hometown || '').trim(),
      residence: (form.residence || '').trim(),
      contact: (form.contact || '').trim()
    }
    // 普通成员仅修改本人绑定的身份资料，关系与结构字段不提交
    if (this.data.personalOnly) return personal
    const father = this.data.parentOptions[this.data.fatherIndex]
    const mother = this.data.parentOptions[this.data.motherIndex]
    return Object.assign(personal, {
      code: (form.code || '').trim(),
      generation: numOrNull(form.generation),
      sibling_rank: numOrNull(form.sibling_rank),
      relation_type: REL_TYPES[this.data.relIndex],
      father_id: father && father.id ? father.id : null,
      mother_id: mother && mother.id ? mother.id : null,
      spouse_ids: this.data.spouseIds.filter(function (id) { return id > 0 })
    })
  },

  submit: function () {
    const that = this
    const payload = this.buildPayload()
    if (!payload.name) {
      wx.showToast({ title: '请填写姓名', icon: 'none' })
      return
    }
    if (payload.birth_year && payload.death_year && payload.death_year < payload.birth_year) {
      wx.showToast({ title: '去世年不能早于出生年', icon: 'none' })
      return
    }
    this.setData({ submitting: true })
    const gid = this.data.genealogyId
    const isEdit = this.data.mode === 'edit'
    const request = isEdit
      ? api.request('/api/genealogies/' + gid + '/members/' + this.data.memberId, { method: 'PUT', data: payload })
      : api.request('/api/genealogies/' + gid + '/members', { method: 'POST', data: payload })

    request.then(function (data) {
      if (data && data.submitted) {
        wx.showToast({ title: '已提交管理员审批', icon: 'none' })
        setTimeout(function () { wx.navigateBack() }, 900)
        return
      }
      const memberId = (data && data.member_id) || that.data.memberId
      if (that.data.photoPath && memberId) {
        return api.upload('/api/genealogies/' + gid + '/members/' + memberId + '/photo', that.data.photoPath)
          .then(function () { return true })
      }
      return true
    }).then(function (done) {
      if (!done) return
      that.setData({ submitting: false })
      wx.showToast({ title: isEdit ? '已保存' : '已新增', icon: 'success' })
      setTimeout(function () { wx.navigateBack() }, 600)
    }).catch(function (err) {
      that.setData({ submitting: false })
      api.toastError(err)
    })
  }
})
