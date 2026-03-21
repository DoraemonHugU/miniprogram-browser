---
name: image-processing
description: When you need offline image-processing scripts for visual comparison workflows.
---

# Image Processing

## When to use

- Use this skill when you need local, script-first image processing for visual comparison work.
- Prefer it for offline runs that prepare, compare, diff, annotate, or compose images without a browser service.

## Script purposes

- `normalize.py`: standardize image inputs before comparison.
- `compare.py`: compute comparison metrics for two prepared images.
- `diff.py`: generate visual diff artifacts.
- `annotate.py`: add boxes, labels, or callouts to output images.
- `montage.py`: assemble multiple images into a review-friendly composite.

## Dependencies

- Install Python dependencies from `skills/image-processing/requirements.txt`.
- Recommended command: `python -m pip install -r skills/image-processing/requirements.txt`.
- Keep the workflow local and file-based so outputs stay portable across worktrees and machines.
