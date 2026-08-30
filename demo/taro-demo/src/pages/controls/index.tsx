import { useState } from 'react'
import {
  Button,
  Checkbox,
  CheckboxGroup,
  Input,
  Label,
  Radio,
  RadioGroup,
  Switch,
  Text,
  View
} from '@tarojs/components'
import './index.css'

export default function Controls() {
  const [text, setText] = useState('')
  const [tapCount, setTapCount] = useState(0)
  const [enabled, setEnabled] = useState(false)
  const [checkedValues, setCheckedValues] = useState<string[]>([])
  const [radioValue, setRadioValue] = useState('first')
  const [status, setStatus] = useState('Ready')

  const reset = () => {
    setText('')
    setTapCount(0)
    setEnabled(false)
    setCheckedValues([])
    setRadioValue('first')
    setStatus('Ready')
  }

  return (
    <View className='container'>
      <Text className='title'>Controls</Text>
      <Text className='hint'>Synthetic public demo state is shown after each interaction.</Text>
      <Text className='label'>Input</Text>
      <Input id='controls-input' className='input' placeholder='Type synthetic text' value={text} onInput={(event) => {
        setText(event.detail.value)
        setStatus('Input changed')
      }} />
      <Text className='label'>Button</Text>
      <Button id='controls-button' type='primary' onClick={() => {
        setTapCount(tapCount + 1)
        setStatus('Button tapped')
      }}>Tap button</Button>
      <View className='row'>
        <Text className='label'>Switch</Text>
        <Switch id='controls-switch' checked={enabled} onChange={(event) => {
          setEnabled(event.detail.value)
          setStatus(event.detail.value ? 'Switch enabled' : 'Switch disabled')
        }} />
      </View>
      <Text className='label'>Checkbox group</Text>
      <CheckboxGroup id='controls-checkbox-group' onChange={(event) => {
        setCheckedValues(event.detail.value)
        setStatus('Checkbox selection changed')
      }}>
        <Label className='option'><Checkbox value='alpha' checked={checkedValues.includes('alpha')} />Alpha</Label>
        <Label className='option'><Checkbox value='beta' checked={checkedValues.includes('beta')} />Beta</Label>
      </CheckboxGroup>
      <Text className='label'>Radio group</Text>
      <RadioGroup id='controls-radio-group' onChange={(event) => {
        setRadioValue(event.detail.value)
        setStatus('Radio selection changed')
      }}>
        <Label className='option'><Radio value='first' checked={radioValue === 'first'} />First</Label>
        <Label className='option'><Radio value='second' checked={radioValue === 'second'} />Second</Label>
      </RadioGroup>
      <Text className='status'>Status: {status}</Text>
      <Text className='status'>Input: {text}</Text>
      <Text className='status'>Button taps: {tapCount}</Text>
      <Text className='status'>Switch: {enabled ? 'on' : 'off'}</Text>
      <Text className='status'>Checkboxes: {checkedValues.join(', ') || 'none'}</Text>
      <Text className='status'>Radio: {radioValue}</Text>
      <Button onClick={reset}>Reset controls</Button>
    </View>
  )
}
