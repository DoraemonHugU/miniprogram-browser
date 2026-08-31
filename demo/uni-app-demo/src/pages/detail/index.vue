<template>
  <view class="container">
    <text class="title">Synthetic Detail</text>
    <text class="hint">This target page is part of the public demo navigation journey.</text>
    <text class="status">Opened from: {{ source }}</text>
    <button id="detail-back" @tap="onBack">Back to navigation</button>
  </view>
</template>

<script setup lang="ts">
import { onLoad } from "@dcloudio/uni-app";
import { ref } from "vue";

const source = ref("unknown");

onLoad((options) => {
  source.value = options?.source || "direct";
});

function onBack() {
  uni.navigateBack();
}
</script>
