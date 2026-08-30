<template>
  <view class="container">
    <text class="title">Public Demo Catalog</text>
    <text class="hint">Synthetic public demo only. Choose a page to inspect a standard mini-program interaction.</text>

    <navigator id="catalog-card-controls" class="card" url="/pages/controls/index">
      <text class="card-title">Controls</text>
      <text class="card-description">Input, button, switch, checkbox, and radio states</text>
      <text class="card-link">Open page →</text>
    </navigator>

    <navigator id="catalog-card-lists" class="card" url="/pages/lists/index">
      <text class="card-title">Lists</text>
      <text class="card-description">Repeated selectors and dynamic list updates</text>
      <text class="card-link">Open page →</text>
    </navigator>

    <navigator id="catalog-card-navigation" class="card" url="/pages/navigation/index">
      <text class="card-title">Navigation</text>
      <text class="card-description">Navigate to a detail page and return</text>
      <text class="card-link">Open page →</text>
    </navigator>

    <navigator id="catalog-card-interaction" class="card" url="/pages/interaction/index">
      <text class="card-title">Interaction</text>
      <text class="card-description">Scroll, swipe, long press, modal, and transient states</text>
      <text class="card-link">Open page →</text>
    </navigator>
  </view>
</template>
