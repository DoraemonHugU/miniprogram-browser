import { useState } from 'react'
import { Button, Text, View } from '@tarojs/components'
import './index.css'

type ListItem = {
  id: string
  label: string
}

const initialItems: ListItem[] = [
  { id: 'item-1', label: 'Synthetic item 1' },
  { id: 'item-2', label: 'Synthetic item 2' },
  { id: 'item-3', label: 'Synthetic item 3' }
]

export default function Lists() {
  const [items, setItems] = useState(initialItems)
  const [selectedId, setSelectedId] = useState('')
  const [nextId, setNextId] = useState(4)
  const [status, setStatus] = useState('No item selected')

  const addItem = () => {
    const item = { id: `item-${nextId}`, label: `Synthetic item ${nextId}` }
    setItems(items.concat(item))
    setNextId(nextId + 1)
    setStatus(`Added ${item.label}`)
  }

  const selectItem = (item: ListItem) => {
    setSelectedId(item.id)
    setStatus(`Selected ${item.label}`)
  }

  const removeItem = (item: ListItem) => {
    setItems(items.filter((candidate) => candidate.id !== item.id))
    if (selectedId === item.id) setSelectedId('')
    setStatus(`Removed ${item.label}`)
  }

  return (
    <View className='container'>
      <Text className='title'>Lists</Text>
      <Text className='hint'>Repeated buttons use stable indexes and synthetic ids for selector testing.</Text>
      <Button id='list-add' type='primary' onClick={addItem}>Add item</Button>
      <View className='list' id='synthetic-list'>
        {items.map((item, index) => (
          <View className='list-item' id={`list-item-${item.id}`} key={item.id}>
            <Text className='item-label'>{item.label}</Text>
            <View className='item-actions'>
              <Button className='item-button' size='mini' data-index={index} onClick={() => selectItem(item)}>Select</Button>
              <Button className='item-button' size='mini' data-index={index} onClick={() => removeItem(item)}>Remove</Button>
            </View>
          </View>
        ))}
      </View>
      <Text className='status'>Status: {status}</Text>
      <Text className='status'>Selected id: {selectedId || 'none'}</Text>
    </View>
  )
}
