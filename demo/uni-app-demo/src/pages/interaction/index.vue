<template>
  <view class="container">
    <text class="title">Interaction</text>
    <text class="hint">Synthetic controls for real scrolling, gestures, modal actions, and short-lived UI states.</text>
    <text id="interaction-status" class="status">Status: {{ status }}</text>

    <text class="section-title">Scrollable container</text>
    <scroll-view id="interaction-scroll" class="scroll-panel" scroll-y>
      <view v-for="item in scrollItems" :key="item" class="scroll-item">{{ item }}</view>
    </scroll-view>

    <text class="section-title">Swipe target</text>
    <swiper id="interaction-swiper" class="swiper" indicator-dots @change="onSwiperChange">
      <swiper-item><view class="slide slide-a">Synthetic slide 1</view></swiper-item>
      <swiper-item><view class="slide slide-b">Synthetic slide 2</view></swiper-item>
      <swiper-item><view class="slide slide-c">Synthetic slide 3</view></swiper-item>
    </swiper>
    <text id="interaction-swiper-status" class="status">Swiper index: {{ swiperIndex }}</text>

    <view id="interaction-longpress" class="gesture-target" @longpress="onLongpress">Long press target</view>
    <button id="interaction-modal" @tap="onOpenModal">Open modal</button>
    <button id="interaction-transient" @tap="onShowTransient">Show transient state</button>
    <text id="interaction-transient-status" class="transient">{{ transientStatus }}</text>

    <view class="page-spacer">Page scroll test area</view>
    <button id="interaction-bottom" @tap="onBottomTap">Bottom page action</button>
    <text id="interaction-bottom-status" class="status">Bottom taps: {{ bottomTapCount }}</text>
  </view>
</template>

<script setup lang="ts">
import { onUnmounted, ref } from "vue";

const status = ref("Ready");
const swiperIndex = ref(0);
const transientStatus = ref("Transient hidden");
const bottomTapCount = ref(0);
const scrollItems = Array.from({ length: 8 }, (_, index) => `Synthetic row ${index + 1}`);
let transientTimer: ReturnType<typeof setTimeout> | undefined;

function onSwiperChange(event: Event) {
  const current = (event as Event & { detail: { current: number } }).detail.current;
  swiperIndex.value = current;
  status.value = `Swiped to slide ${current + 1}`;
}

function onLongpress() {
  status.value = "Long press received";
}

function onOpenModal() {
  uni.showModal({
    title: "Synthetic modal",
    content: "This dialog contains public demo text only.",
    success(result) {
      status.value = result.confirm ? "Modal accepted" : "Modal dismissed";
    },
  });
}

function onShowTransient() {
  if (transientTimer) clearTimeout(transientTimer);
  transientStatus.value = "Transient visible";
  status.value = "Transient state shown";
  transientTimer = setTimeout(() => {
    transientStatus.value = "Transient hidden";
  }, 1200);
}

function onBottomTap() {
  bottomTapCount.value += 1;
  status.value = "Bottom action tapped";
}

onUnmounted(() => {
  if (transientTimer) clearTimeout(transientTimer);
});
</script>

<style scoped>
.section-title {
  display: block;
  font-weight: 600;
  margin: 28rpx 0 14rpx;
}

.scroll-panel {
  background: #ffffff;
  border: 1rpx solid #d1d5db;
  border-radius: 12rpx;
  height: 260rpx;
}

.scroll-item {
  border-bottom: 1rpx solid #e5e7eb;
  padding: 24rpx;
}

.swiper { height: 260rpx; }

.slide {
  align-items: center;
  border-radius: 12rpx;
  color: #ffffff;
  display: flex;
  font-size: 34rpx;
  height: 220rpx;
  justify-content: center;
}

.slide-a { background: #2563eb; }
.slide-b { background: #7c3aed; }
.slide-c { background: #0f766e; }

.gesture-target {
  background: #ffffff;
  border: 2rpx dashed #2563eb;
  border-radius: 12rpx;
  margin: 28rpx 0;
  padding: 32rpx;
  text-align: center;
}

.transient {
  color: #7c3aed;
  display: block;
  margin: 20rpx 0;
}

.page-spacer {
  align-items: center;
  color: #9ca3af;
  display: flex;
  height: 900rpx;
  justify-content: center;
}
</style>
