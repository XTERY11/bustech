# Bustech YOLOv8 本机训练

源数据：`C:\Users\Kervi\OneDrive - National University of Singapore\Study_and_work\Bustech`

本项目：`C:\Users\Kervi\Documents\ChatGPT\Bustech`

## 数据检查

| 类别 ID | 类别 | 图片数 | 有标注 | 缺标注 |
|---|---|---:|---:|---:|
| 0 | cane | 800 | 792 | 8 |
| 1 | stroller | 800 | 740 | 60 |
| 2 | wheelchair_with | 800 | 799 | 1 |
| 3 | wheelchair_without | 800 | 800 | 0 |

共 3,200 张图片、3,131 个有效匹配，标签均为归一化 YOLO 检测框格式；未发现格式、类别编号、坐标范围错误或孤立标签。缺失标签不自动当作背景，详见 `audit_report.json`。此检查不代表逐张确认了标注语义。

每段视频按帧序号前约 80% 训练、后约 20% 验证，在分界两侧各排除 2 秒：训练 2,491 张，验证 607 张，间隔排除 33 张。文件名增加来源前缀以防跨视频重名。原始数据不改动，训练文件复制到本地 `dataset`。

四个类别分别只来自一段视频，同场景、同人物相关性强。当前验证集只能用于初步调试，不能代表公交车真实场景的泛化能力；后续应增加独立视频作为测试集。抽查 12 张图片可见，标签主要框住人和器具整体，训练会沿用这一标注定义。查看 `label_preview.jpg`。

## 运行

在本项目目录打开 PowerShell。环境位于 `.venv`，无需激活。

本次已启动后台流程：先用 12 张抽查图片试跑 1 epoch，再继续整理全部数据、解码检查图片，最后自动执行正式训练。`pipeline_status.json` 表示当前阶段，`pipeline.log` 和 `pipeline_error.log` 保存输出。进度条通常写入 error 日志，不代表训练出错。运行期间请保持电脑开机、联网，避免睡眠。

查看状态：

首次完整性检查发现本地副本损坏，已启动修复和训练接续流程；本次后续输出请查看 `recovery.log` 和 `recovery_error.log`，图片检查与修复明细保存在 `image_validation_report.json`。

```powershell
Get-Content .\pipeline_status.json
Get-Content .\recovery.log -Tail 30
```

不要在后台流程运行时重复启动训练。若流程已停止，可运行 `.\.venv\Scripts\python.exe -u run_pipeline.py`；若正式训练已产生 `last.pt`，优先使用下面的 `--resume` 恢复训练。试跑指标只用于验证程序运行，不能作为模型效果。

```powershell
# 仅在需要重新准备数据时运行；已存在的完整数据集不会被覆盖
.\.venv\Scripts\python.exe prepare_dataset.py --prepare
# 上次复制中断时（相同参数）
.\.venv\Scripts\python.exe prepare_dataset.py --prepare --resume

# 正式训练：YOLOv8n 预训练权重，640 像素，batch 8，100 epochs
.\.venv\Scripts\python.exe train.py

# 训练中断后，按实际输出目录继续
.\.venv\Scripts\python.exe train.py --resume runs\bustech_yolov8n\weights\last.pt
```

默认使用 GPU 0，早停 patience=20，Windows workers=0，禁用内存图片缓存。遇到显存不足可用 `--batch 4`。首次训练需要联网下载 `yolov8n.pt`。参数为初始基线，不是已调优配置。

训练结果保存在 `runs` 下，包括 `weights/best.pt`、`weights/last.pt`、`results.csv` 和指标图。重复运行会创建新目录，以上恢复路径需对应实际运行。

## 重建环境

使用 Python 3.12 创建 `.venv` 后运行：

```powershell
.\.venv\Scripts\python.exe -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu128
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -c "import torch; print(torch.cuda.is_available()); print(torch.cuda.get_device_name(0))"
```

官方参考：[YOLOv8](https://docs.ultralytics.com/models/yolov8/)、[数据格式](https://docs.ultralytics.com/datasets/detect/)、[PyTorch 安装](https://pytorch.org/get-started/locally/)。
