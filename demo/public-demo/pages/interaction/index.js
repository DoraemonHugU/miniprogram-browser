Page({
  data: {
    status: 'Ready',
    swiperIndex: 0,
    swipeStatus: 'ready',
    scrollTop: 0,
    pageScrollTop: 0,
    transientStatus: 'Transient hidden',
    bottomTapCount: 0,
    scrollItems: [
      'Synthetic row 1',
      'Synthetic row 2',
      'Synthetic row 3',
      'Synthetic row 4',
      'Synthetic row 5',
      'Synthetic row 6',
      'Synthetic row 7',
      'Synthetic row 8'
    ]
  },

  onSwiperChange(event) {
    this.setData({
      swiperIndex: event.detail.current,
      status: `Swiped to slide ${event.detail.current + 1}`
    })
  },

  onScroll(event) {
    this.setData({ scrollTop: Math.round(event.detail.scrollTop) })
  },

  onPageScroll(event) {
    this.setData({ pageScrollTop: Math.round(event.scrollTop) })
  },

  onSwipeStart(event) {
    this.swipeStartX = event.touches[0].clientX
  },

  onSwipeEnd(event) {
    const endX = event.changedTouches[0].clientX
    const direction = endX < this.swipeStartX ? 'left' : 'right'
    this.setData({
      swipeStatus: direction,
      status: `View swiped ${direction}`
    })
  },

  onLongpress() {
    this.setData({ status: 'Long press received' })
  },

  onOpenModal() {
    wx.showModal({
      title: 'Synthetic modal',
      content: 'This dialog contains public demo text only.',
      success: (result) => {
        this.setData({ status: result.confirm ? 'Modal accepted' : 'Modal dismissed' })
      }
    })
  },

  onShowTransient() {
    clearTimeout(this.transientTimer)
    this.setData({
      transientStatus: 'Transient visible',
      status: 'Transient state shown'
    })
    this.transientTimer = setTimeout(() => {
      this.setData({ transientStatus: 'Transient hidden' })
    }, 2400)
  },

  onBottomTap() {
    this.setData({
      bottomTapCount: this.data.bottomTapCount + 1,
      status: 'Bottom action tapped'
    })
  },

  onUnload() {
    clearTimeout(this.transientTimer)
  }
})
