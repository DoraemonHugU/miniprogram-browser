Page({
  data: {
    items: [
      { id: 'item-1', label: 'Synthetic item 1' },
      { id: 'item-2', label: 'Synthetic item 2' },
      { id: 'item-3', label: 'Synthetic item 3' }
    ],
    selectedId: '',
    nextId: 4,
    status: 'No item selected'
  },

  onSelect(event) {
    const item = this.data.items[event.currentTarget.dataset.index]
    this.setData({
      selectedId: item.id,
      status: `Selected ${item.label}`
    })
  },

  onRemove(event) {
    const index = event.currentTarget.dataset.index
    const item = this.data.items[index]
    const items = this.data.items.slice()
    items.splice(index, 1)
    this.setData({
      items,
      selectedId: this.data.selectedId === item.id ? '' : this.data.selectedId,
      status: `Removed ${item.label}`
    })
  },

  onAdd() {
    const id = `item-${this.data.nextId}`
    const item = { id, label: `Synthetic item ${this.data.nextId}` }
    this.setData({
      items: this.data.items.concat(item),
      nextId: this.data.nextId + 1,
      status: `Added ${item.label}`
    })
  }
})
