import { Navigator, View, Text } from '@tarojs/components'
import './index.css'

export default function Index() {
  return (
    <View className='container'>
      <Text className='title'>Public Demo Catalog</Text>
      <Text className='hint'>Synthetic public demo only. Choose a page to inspect a standard mini-program interaction.</Text>
      <Navigator className='card' id='catalog-card-controls' url='/pages/controls/index'>
        <Text className='card-title'>Controls</Text>
        <Text className='card-description'>Input, button, switch, checkbox, and radio states</Text>
        <Text className='card-link'>Open page →</Text>
      </Navigator>
      <Navigator className='card' id='catalog-card-lists' url='/pages/lists/index'>
        <Text className='card-title'>Lists</Text>
        <Text className='card-description'>Repeated selectors and dynamic list updates</Text>
        <Text className='card-link'>Open page →</Text>
      </Navigator>
      <Navigator className='card' id='catalog-card-navigation' url='/pages/navigation/index'>
        <Text className='card-title'>Navigation</Text>
        <Text className='card-description'>Navigate to a detail page and return</Text>
        <Text className='card-link'>Open page →</Text>
      </Navigator>
      <Navigator className='card' id='catalog-card-interaction' url='/pages/interaction/index'>
        <Text className='card-title'>Interaction</Text>
        <Text className='card-description'>Scroll, swipe, long press, modal, and transient states</Text>
        <Text className='card-link'>Open page →</Text>
      </Navigator>
    </View>
  )
}
