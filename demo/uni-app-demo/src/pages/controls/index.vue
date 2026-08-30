<template>
  <view class="container">
    <text class="title">Controls</text>
    <text class="hint">Synthetic public demo state is shown after each interaction.</text>

    <text class="label">Input</text>
    <input
      id="controls-input"
      class="input"
      placeholder="Type synthetic text"
      :value="text"
      @input="onInput"
    />

    <text class="label">Button</text>
    <button id="controls-button" @tap="onButtonTap">Tap button</button>

    <view class="row">
      <text class="label">Switch</text>
      <switch id="controls-switch" :checked="enabled" @change="onSwitchChange" />
    </view>

    <text class="label">Checkbox group</text>
    <checkbox-group id="controls-checkbox-group" @change="onCheckboxChange">
      <label class="option"><checkbox value="alpha" :checked="alphaChecked" />Alpha</label>
      <label class="option"><checkbox value="beta" :checked="betaChecked" />Beta</label>
    </checkbox-group>

    <text class="label">Radio group</text>
    <radio-group id="controls-radio-group" @change="onRadioChange">
      <label class="option"><radio value="first" :checked="radioFirstChecked" />First</label>
      <label class="option"><radio value="second" :checked="radioSecondChecked" />Second</label>
    </radio-group>

    <text class="status">Status: {{ status }}</text>
    <text class="status">Input: {{ text }}</text>
    <text class="status">Button taps: {{ tapCount }}</text>
    <text class="status">Switch: {{ enabledText }}</text>
    <text class="status">Checkboxes: {{ checkboxSummary }}</text>
    <text class="status">Radio: {{ radioValue }}</text>
    <button id="controls-reset" @tap="onReset">Reset controls</button>
  </view>
</template>

<script setup lang="ts">
import { ref } from "vue";

const text = ref("");
const tapCount = ref(0);
const enabled = ref(false);
const enabledText = ref("off");
const checkedValues = ref<string[]>([]);
const alphaChecked = ref(false);
const betaChecked = ref(false);
const checkboxSummary = ref("none");
const radioValue = ref("first");
const radioFirstChecked = ref(true);
const radioSecondChecked = ref(false);
const status = ref("Ready");

function onInput(event: Event) {
  text.value = (event as Event & { detail: { value: string } }).detail.value;
  status.value = "Input changed";
}

function onButtonTap() {
  tapCount.value += 1;
  status.value = "Button tapped";
}

function onSwitchChange(event: Event) {
  const value = (event as Event & { detail: { value: boolean } }).detail.value;
  enabled.value = value;
  enabledText.value = value ? "on" : "off";
  status.value = value ? "Switch enabled" : "Switch disabled";
}

function onCheckboxChange(event: Event) {
  checkedValues.value = (event as Event & { detail: { value: string[] } }).detail.value;
  alphaChecked.value = checkedValues.value.includes("alpha");
  betaChecked.value = checkedValues.value.includes("beta");
  checkboxSummary.value = checkedValues.value.join(", ") || "none";
  status.value = "Checkbox selection changed";
}

function onRadioChange(event: Event) {
  const value = (event as Event & { detail: { value: string } }).detail.value;
  radioValue.value = value;
  radioFirstChecked.value = value === "first";
  radioSecondChecked.value = value === "second";
  status.value = "Radio selection changed";
}

function onReset() {
  text.value = "";
  tapCount.value = 0;
  enabled.value = false;
  enabledText.value = "off";
  checkedValues.value = [];
  alphaChecked.value = false;
  betaChecked.value = false;
  checkboxSummary.value = "none";
  radioValue.value = "first";
  radioFirstChecked.value = true;
  radioSecondChecked.value = false;
  status.value = "Ready";
}
</script>
