---
name: image-processing
description: 当需要离线处理图片，用于拼图、差异分析、局部放大或叠加对比时使用。
---

# 图片处理

用于把已有图片整理成更适合人和模型分析的输入。

这不是自动截图或自动回归系统，而是一组离线图片处理原语。

## 何时使用

- 需要把 before / after / reference 拼成一张图
- 需要生成差异图
- 需要单独放大某个局部区域
- 需要做辅助叠加对比

## 脚本

- `scripts/img_montage.py`：多图横向拼接
- `scripts/img_diff.py`：生成差异图，并回显差异框
- `scripts/img_focus.py`：按显式 `box` 裁剪单张图片
- `scripts/img_overlay.py`：生成彩色叠加图

## 怎么选

默认先看 `img_montage.py` 和 `img_diff.py`；需要单独放大某一块时，再自己指定 `box` 调 `img_focus.py`；`img_overlay.py` 只作辅助。

- 先看整体布局：`img_montage.py`
- 先找哪里变了：`img_diff.py`
- 已经知道要看哪一块：`img_focus.py`
- 想看微小位移或重叠：`img_overlay.py`

## 怎么理解输出

- `img_montage.py` 适合先建立整体上下文
- `img_diff.py` 的 `box1 / box2 ...` 是“候选变化区域”，不是绝对真理
- `img_focus.py` 不替你决定看哪一块；它只是把你指定的区域裁出来并自动放大
- `img_overlay.py` 更适合看细微位移，不适合作为唯一证据

## 边界

- `img_focus.py` 不负责自动找区域，区域选择权完全交给调用方
- 尺寸统一属于内部实现细节，由脚本在需要时自动处理
- 不负责自动截图、浏览器/小程序自动化、自动回归结论、高级图像配准

## 常见误区

- 只看 `img_overlay.py`，不看 `montage` 或 `diff`
- 把 `img_diff.py` 回显的 box 当成绝对精确框
- 拿来源不同、分辨率不同、压缩方式不同的图片直接硬比，然后把缩放误差当成真实变化
- 期待 `img_focus.py` 自动帮你决定关注区域

## 最小配方

### 先定位变化，再手动放大局部

1. 跑 `img_diff.py`
2. 从回显里挑一个 box
3. 用同一个 box 去裁原图或 diff 图

### 给模型看图时的主顺序

1. `img_montage.py`
2. `img_diff.py`
3. `img_focus.py`

如果还要看细微位移，再补 `img_overlay.py`

## 依赖与参数

- 安装依赖：`python -m pip install -r requirements.txt`
- 具体参数以各脚本的 `--help` 为准
