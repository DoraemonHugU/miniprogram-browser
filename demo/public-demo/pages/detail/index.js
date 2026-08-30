Page({
  data: {
    source: 'unknown'
  },

  onLoad(options) {
    this.setData({ source: options.source || 'direct' })
  },

  onBack() {
    wx.navigateBack()
  }
})
