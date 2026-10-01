# 摄像头区域监测

脚本：`monitor_zone.py`。默认加载本项目 `runs/bustech_yolov8n/weights/best.pt`，优先使用 CUDA，无 GPU 时使用 CPU。不重新训练模型，也不会默认录制视频。

## 最简单的启动方式

双击 `start_monitor.cmd`，输入摄像头编号（通常为 `0`，其他 USB 摄像头可能是 `1`）、本地视频完整路径，或 RTSP/HTTP 视频流地址。

也可以在 CMD 中运行：

```cmd
cd /d "D:\Projects\Bustech"
.venv\Scripts\python.exe monitor_zone.py --source 0
```

先用已有视频练习画区域：

```cmd
.venv\Scripts\python.exe monitor_zone.py --source "demos\clips\wheelchair_test.mp4" --roi practice_roi.json
```

视频文件播完会退出，重新运行即可再播放。USB 摄像头和网络视频流则持续运行，直到退出或读取失败。摄像头/网络流连接失败时会显示错误并停止；本版不自动重连。

## 交互操作

| 操作 | 效果 |
|---|---|
| 鼠标左键 | 按顺序添加区域顶点，至少 3 个 |
| 鼠标右键 | 撤销最后一个顶点 |
| Enter | 确认区域，保存配置，开始监测 |
| R | 重新绘制区域 |
| Esc | 取消修改并恢复旧区域；没有旧区域时退出 |
| 空格 | 暂停/继续本地视频，暂停期间不监测 |
| Q 或关闭窗口 | 退出程序并释放摄像头 |

顶点边线不能自交，支持凹多边形。绘制区域期间禁用触发判断；本地视频暂停在当前画面，摄像头画面继续更新。区域默认保存在 `monitor_roi.json`，下次自动读取。坐标按比例保存，可适应相同视野的不同分辨率；移动相机、更换镜头、调整旋转或改变裁切后需按 R 重画。

界面使用英文，避免 OpenCV 默认字体不支持中文导致乱码。绿色区域表示监测中，触发后区域变红，顶部显示红色 `TRIGGER`。检测框上的圆点是用于判断是否进入区域的位置。

## 触发规则

默认判断检测框**底边中心点**是否在多边形内部或边界上，适用于人和辅助器具的地面区域监测。它不是“只要检测框与区域有任何重叠就触发”。可使用 `--anchor center` 改为检测框中心点；确认区域时会保存当前判断方式。

四个类别均参与判断，默认置信度阈值 0.40。区域内连续 2 帧出现任一目标后进入触发状态，持续显示 `TRIGGER`；连续 5 帧没有符合条件的目标后清除。目标离开后再次进入可以再次触发。控制台只在未触发→触发时打印一条事件。

这是区域占用提示，不是逐个目标计数：当区域已经有目标时，第二个目标进入不会产生独立的新事件。尚未接入外部设备或发送信号。

```cmd
REM 希望第一帧进入就触发、第一帧离开就清除
.venv\Scripts\python.exe monitor_zone.py --source 0 --enter-frames 1 --exit-frames 1

REM 只监测有人轮椅和空轮椅，提高置信度要求
.venv\Scripts\python.exe monitor_zone.py --source 0 --classes 2 3 --conf 0.6

REM 网络摄像头，给该视角使用独立区域文件
.venv\Scripts\python.exe monitor_zone.py --source "rtsp://CAMERA_ADDRESS/STREAM" --roi network_camera_roi.json

REM 画面横倒时先旋正，再画区域
.venv\Scripts\python.exe monitor_zone.py --source 0 --rotate ccw
```

类别编号：0 cane，1 stroller，2 wheelchair_with，3 wheelchair_without。模型沿用人和器具整体的标注定义，可能误检/漏检；置信度阈值和区域需要用实际摄像头画面调整。

## 可选保存

`--events events.jsonl` 追加保存每次从未触发变为触发的事件；`--output monitor_recording.avi` 保存带框画面（MJPG，无音频）。记录视频使用源 FPS，若推理跟不上实时输入，录制时间不保证与真实经过时间一致。默认不保存这些文件。

已提供独立的示例区域 `monitor_example_roi.json`，仅适合现有测试片段，不能直接当作实际摄像头区域：

```cmd
.venv\Scripts\python.exe monitor_zone.py --source "demos\clips\wheelchair_test.mp4" --roi monitor_example_roi.json
```

## 验证范围

自动测试覆盖区域边界、凹多边形、自交/无效区域、连续帧进入/离开确认，以及鼠标顶点输入和配置保存。真实模型联调使用已有本地测试视频。实际 USB 摄像头、网络流延迟和设备权限需要接上设备后验证；网络摄像头自身的缓冲可能导致画面延迟。

本次验证：5 项自动测试通过；12 帧区域内测试产生 1 次触发、区域外测试没有触发；完整 300 帧测试产生 1 次触发并随后清除。`monitor_demo.mp4` 展示完整的 10 秒示例，示例区域文件与正式摄像头配置分开保存。
