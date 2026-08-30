<template>
  <view class="container">
    <text class="title">Navigation</text>
    <text class="hint">Use the button to open a detail page, then return with the page navigation controls.</text>
    <button id="navigation-detail" @tap="onOpenDetail">Open detail page</button>
    <text class="status">Status: {{ status }}</text>
    <text class="status">Navigation page shows: {{ visits }}</text>
  </view>
</template>

<script setup lang="ts">
import { onShow } from "@dcloudio/uni-app";
import { ref } from "vue";

const visits = ref(0);
const status = ref("Ready to navigate");

onShow(() => {
  visits.value += 1;
});

function onOpenDetail() {
  status.value = "Opening detail page";
  uni.navigateTo({ url: "/pages/detail/index?source=navigation" });
}
</script>
