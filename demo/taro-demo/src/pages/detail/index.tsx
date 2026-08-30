import { Button, Text, View } from '@tarojs/components'
import Taro, { useLoad } from '@tarojs/taro'
import { useState } from 'react'
import './index.css'

export default function Detail() {
  const [source, setSource] = useState('unknown')

  useLoad((options) => {
    setSource(options?.source || 'direct')
  })

  return (
    <View className='container'>
      <Text className='title'>Synthetic Detail</Text>
      <Text className='hint'>This target page is part of the public demo navigation journey.</Text>
      <Text className='status'>Opened from: {source}</Text>
      <Button id='detail-back' type='primary' onClick={() => Taro.navigateBack()}>Back to navigation</Button>
    </View>
  )
}
