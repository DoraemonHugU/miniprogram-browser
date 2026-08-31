Page({
  data: {
    text: '',
    tapCount: 0,
    enabled: false,
    enabledText: 'off',
    checkedValues: [],
    alphaChecked: false,
    betaChecked: false,
    checkboxSummary: 'none',
    radioValue: 'first',
    radioFirstChecked: true,
    radioSecondChecked: false,
    status: 'Ready'
  },

  onInput(event) {
    this.setData({
      text: event.detail.value,
      status: 'Input changed'
    })
  },

  onButtonTap() {
    this.setData({
      tapCount: this.data.tapCount + 1,
      status: 'Button tapped'
    })
  },

  onSwitchChange(event) {
    this.setData({
      enabled: event.detail.value,
      enabledText: event.detail.value ? 'on' : 'off',
      status: event.detail.value ? 'Switch enabled' : 'Switch disabled'
    })
  },

  onCheckboxChange(event) {
    const checkedValues = event.detail.value
    this.setData({
      checkedValues,
      alphaChecked: checkedValues.indexOf('alpha') >= 0,
      betaChecked: checkedValues.indexOf('beta') >= 0,
      checkboxSummary: checkedValues.join(', ') || 'none',
      status: 'Checkbox selection changed'
    })
  },

  onRadioChange(event) {
    this.setData({
      radioValue: event.detail.value,
      radioFirstChecked: event.detail.value === 'first',
      radioSecondChecked: event.detail.value === 'second',
      status: 'Radio selection changed'
    })
  },

  onReset() {
    this.setData({
      text: '',
      tapCount: 0,
      enabled: false,
      enabledText: 'off',
      checkedValues: [],
      alphaChecked: false,
      betaChecked: false,
      checkboxSummary: 'none',
      radioValue: 'first',
      radioFirstChecked: true,
      radioSecondChecked: false,
      status: 'Ready'
    })
  }
})
