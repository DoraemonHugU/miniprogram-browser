<template>
  <view class="container">
    <text class="title">Lists</text>
    <text class="hint">Repeated buttons use stable keys and synthetic ids for selector testing.</text>
    <button id="list-add" @tap="onAdd">Add item</button>

    <view id="synthetic-list" class="list">
      <view
        v-for="(item, index) in items"
        :id="`list-item-${item.id}`"
        :key="item.id"
        class="list-item"
      >
        <text class="item-label">{{ item.label }}</text>
        <view class="item-actions">
          <button class="item-button" size="mini" :data-index="index" @tap="onSelect(index)">Select</button>
          <button class="item-button" size="mini" :data-index="index" @tap="onRemove(index)">Remove</button>
        </view>
      </view>
    </view>

    <text class="status">Status: {{ status }}</text>
    <text class="status">Selected id: {{ selectedId || "none" }}</text>
  </view>
</template>

<script setup lang="ts">
import { ref } from "vue";

type DemoItem = { id: string; label: string };

const items = ref<DemoItem[]>([
  { id: "item-1", label: "Synthetic item 1" },
  { id: "item-2", label: "Synthetic item 2" },
  { id: "item-3", label: "Synthetic item 3" },
]);
const selectedId = ref("");
const nextId = ref(4);
const status = ref("No item selected");

function onSelect(index: number) {
  const item = items.value[index];
  if (!item) return;
  selectedId.value = item.id;
  status.value = `Selected ${item.label}`;
}

function onRemove(index: number) {
  const item = items.value[index];
  if (!item) return;
  items.value.splice(index, 1);
  if (selectedId.value === item.id) selectedId.value = "";
  status.value = `Removed ${item.label}`;
}

function onAdd() {
  const id = `item-${nextId.value}`;
  const item = { id, label: `Synthetic item ${nextId.value}` };
  items.value.push(item);
  nextId.value += 1;
  status.value = `Added ${item.label}`;
}
</script>
