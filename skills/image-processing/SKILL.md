---
name: image-processing
description: Use when you need offline image-processing helpers for visual comparison, screenshot review, diffing, or focus-crop analysis.
---

# Image Processing

## 概述

这是一组离线图片处理脚本，用来把多张截图整理成更适合人和模型分析的输入。

它不负责自动截图，也不负责自动生成回归结论；它只提供可组合的图片处理原语。

## 何时使用

- 需要把 before / after / reference 拼成一张图
- 需要生成差异热区图
- 需要看两张图的彩色叠加效果
- 需要把局部变化区域放大，帮助模型把注意力集中到变化点

## 安装依赖

```bash
python -m pip install -r skills/image-processing/requirements.txt
```

如果项目里不想污染全局 Python，优先使用虚拟环境。

## 核心脚本

- `img_normalize.py`：把单张图片归一化到指定画布
- `img_montage.py`：把 2 张或多张图横向拼接成一张
- `img_diff.py`：生成差异图，并自动写 `*.regions.json`
- `img_overlay.py`：生成颜色区分叠加图（before=red, after=cyan）
- `img_focus_crops.py`：根据变化区域生成局部放大 sheet

## 推荐顺序

默认先看：

1. `img_montage.py`
2. `img_diff.py`
3. `img_focus_crops.py`

`img_overlay.py` 是辅助视图，更适合看微小位移，不适合作为唯一证据。

## 常用组合

### 先做差异，再做局部放大

```bash
python skills/image-processing/scripts/img_diff.py before.png after.png -o diff.png
python skills/image-processing/scripts/img_focus_crops.py before.png after.png --regions diff.regions.json -o focus.png
```

### 最后拼成一张 review sheet

```bash
python skills/image-processing/scripts/img_montage.py before.png after.png diff.png focus.png -o review-sheet.png
```

### 显式归一化单张图

```bash
python skills/image-processing/scripts/img_normalize.py screenshot.png --size 1280x720 --mode pad
```

## 边界

- 这些脚本默认只做文件输入/输出，不做浏览器自动化
- 它们会自动处理尺寸不一致，但不负责高级图像配准
- 如果两张图没有像素级大体对齐，diff/overlay 的结果可能会放大误差
