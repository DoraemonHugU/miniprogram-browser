import { useEffect, useRef, useState } from 'react'
import Taro from '@tarojs/taro'
import {
  Button,
  ScrollView,
  Swiper,
  SwiperItem,
  Text,
  View
} from '@tarojs/components'
import './index.css'

const scrollItems = Array.from({ length: 8 }, (_, index) => `Synthetic row ${index + 1}`)

export default function Interaction() {
  const [status, setStatus] = useState('Ready')
  const [swiperIndex, setSwiperIndex] = useState(0)
  const [transientStatus, setTransientStatus] = useState('Transient hidden')
  const [bottomTapCount, setBottomTapCount] = useState(0)
  const transientTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (transientTimer.current) clearTimeout(transientTimer.current)
  }, [])

  const showTransient = () => {
    if (transientTimer.current) clearTimeout(transientTimer.current)
    setTransientStatus('Transient visible')
    setStatus('Transient state shown')
    transientTimer.current = setTimeout(() => setTransientStatus('Transient hidden'), 1200)
  }

  const openModal = async () => {
    const result = await Taro.showModal({
      title: 'Synthetic modal',
      content: 'This dialog contains public demo text only.'
    })
    setStatus(result.confirm ? 'Modal accepted' : 'Modal dismissed')
  }

  return (
    <View className='container'>
      <Text className='title'>Interaction</Text>
      <Text className='hint'>Synthetic controls for real scrolling, gestures, modal actions, and short-lived UI states.</Text>
      <Text className='status' id='interaction-status'>Status: {status}</Text>

      <Text className='section-title'>Scrollable container</Text>
      <ScrollView id='interaction-scroll' className='scroll-panel' scrollY>
        {scrollItems.map((item) => <View className='scroll-item' key={item}>{item}</View>)}
      </ScrollView>

      <Text className='section-title'>Swipe target</Text>
      <Swiper id='interaction-swiper' className='swiper' indicatorDots onChange={(event) => {
        setSwiperIndex(event.detail.current)
        setStatus(`Swiped to slide ${event.detail.current + 1}`)
      }}>
        <SwiperItem><View className='slide slide-a'>Synthetic slide 1</View></SwiperItem>
        <SwiperItem><View className='slide slide-b'>Synthetic slide 2</View></SwiperItem>
        <SwiperItem><View className='slide slide-c'>Synthetic slide 3</View></SwiperItem>
      </Swiper>
      <Text className='status' id='interaction-swiper-status'>Swiper index: {swiperIndex}</Text>

      <View id='interaction-longpress' className='gesture-target' onLongPress={() => setStatus('Long press received')}>Long press target</View>
      <Button id='interaction-modal' onClick={openModal}>Open modal</Button>
      <Button id='interaction-transient' onClick={showTransient}>Show transient state</Button>
      <Text className='transient' id='interaction-transient-status'>{transientStatus}</Text>

      <View className='page-spacer'>Page scroll test area</View>
      <Button id='interaction-bottom' onClick={() => {
        setBottomTapCount((count) => count + 1)
        setStatus('Bottom action tapped')
      }}>Bottom page action</Button>
      <Text className='status' id='interaction-bottom-status'>Bottom taps: {bottomTapCount}</Text>
    </View>
  )
}
