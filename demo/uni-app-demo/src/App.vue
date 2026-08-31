<script setup lang="ts">
import { onHide, onLaunch, onShow } from "@dcloudio/uni-app";

onLaunch(() => {
  console.log("Public Demo Launch");
});

onShow(() => {
  console.log("Public Demo Show");
});

onHide(() => {
  console.log("Public Demo Hide");
});
</script>

<style>
page {
  background: #f5f7fa;
  color: #1f2937;
  font-family: sans-serif;
}

.container {
  padding: 48rpx;
}

.title {
  display: block;
  font-size: 44rpx;
  font-weight: 600;
  margin-bottom: 16rpx;
}

.hint {
  color: #6b7280;
  display: block;
  line-height: 1.5;
  margin-bottom: 32rpx;
}

.label {
  display: block;
  font-weight: 600;
  margin: 20rpx 0 12rpx;
}

.input {
  background: #ffffff;
  border: 1rpx solid #d1d5db;
  border-radius: 12rpx;
  margin-bottom: 24rpx;
  padding: 20rpx;
}

.status {
  color: #2563eb;
  display: block;
  margin: 28rpx 0;
}

.card {
  background: #ffffff;
  border: 1rpx solid #e5e7eb;
  border-radius: 16rpx;
  margin-bottom: 20rpx;
  padding: 28rpx;
}

.card-title,
.card-description,
.card-link {
  display: block;
}

.card-title {
  font-size: 34rpx;
  font-weight: 600;
  margin-bottom: 10rpx;
}

.card-description {
  color: #6b7280;
  line-height: 1.5;
  margin-bottom: 18rpx;
}

.card-link {
  color: #2563eb;
  font-size: 28rpx;
}

.row {
  align-items: center;
  display: flex;
  justify-content: space-between;
}

.row .label {
  margin-bottom: 0;
}

.option {
  display: block;
  margin: 16rpx 0;
}

.list {
  margin-top: 28rpx;
}

.list-item {
  align-items: center;
  background: #ffffff;
  border: 1rpx solid #e5e7eb;
  border-radius: 12rpx;
  display: flex;
  justify-content: space-between;
  margin-bottom: 16rpx;
  padding: 20rpx;
}

.item-label {
  flex: 1;
}

.item-actions {
  display: flex;
  gap: 12rpx;
}

.item-button {
  margin: 0;
}
</style>
