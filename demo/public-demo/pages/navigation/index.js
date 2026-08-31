Page({
  data: {
    visits: 0,
    status: 'Ready to navigate'
  },

  onShow() {
    this.setData({ visits: this.data.visits + 1 })
  },

  onOpenDetail() {
    this.setData({ status: 'Opening detail page' })
    wx.navigateTo({ url: '/pages/detail/index?source=navigation' })
  }
})
