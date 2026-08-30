import { Text, Button, View } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { useState } from 'react'
import './index.css'

export default function Navigation() {
  const [visits, setVisits] = useState(0)
  const [status, setStatus] = useState('Ready to navigate')

  useDidShow(() => {
    setVisits((value) => value + 1)
  })

  const openDetail = () => {
    setStatus('Opening detail page')
    Taro.navigateTo({ url: '/pages/detail/index?source=navigation' })
  }

  return (
    <View className='container'>
      <Text className='title'>Navigation</Text>
      <Text className='hint'>Use the button to open a detail page, then return with the page navigation controls.</Text>
      <Button id='navigation-detail' type='primary' onClick={openDetail}>Open detail page</Button>
      <Text className='status'>Status: {status}</Text>
      <Text className='status'>Navigation page shows: {visits}</Text>
    </View>
  )
}
