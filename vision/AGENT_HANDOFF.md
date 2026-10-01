# Bustech 项目交接：给接手的 Agent

## 项目是什么、现在做到哪里

本项目用 YOLOv8n 检测拐杖使用者、婴儿车、有人乘坐的轮椅、空轮椅，最终用途是在实时摄像头画面中手工划定多边形监测区域，目标进入后在画面显示 `TRIGGER`。

模型训练已完成（2026-09-20 04:41，100 epochs），五段视频演示已完成，交互监测脚本和录像联调已完成。迁移不需要重新训练。实际摄像头和 RTSP 设备尚未接入验证；不要把本地录像测试描述成实机验证。

进入项目后先阅读本文和 `MONITOR_GUIDE.md`。所有命令从解压后的 `Bustech` 根目录执行；示例中的 `python` 应替换为本项目虚拟环境的 Python。Windows：`.venv\Scripts\python.exe`；macOS/Linux：`.venv/bin/python`。

## 三个迁移包

三个 ZIP 都带 `Bustech/` 顶层目录，解压到同一个父目录即可合并：

1. **Bustech-runtime.zip**：全部项目 Python 源码、启动脚本、依赖说明、best/last 权重、YOLOv8n 基础权重、训练指标图、五段已裁剪原画片段及五段检测演示、区域触发示例和文档。只运行摄像头监测或播放演示时，这个包就够。
2. **Bustech-training-data.zip**：已经整理好的 2,491 张训练图、607 张验证图及对应标签，数据 YAML、样本来源清单。用于重新训练和验证。不含 Ultralytics 缓存。
3. **Bustech-original-materials.zip**：源目录的五个完整 MOV，以及可读取的 `data/`、`label/` 内容。解压后位于 `Bustech/source/`。原机 OneDrive 有 102 张未参与正式训练的原图和 2 个 frames.csv 读取失败，已记录到 `package_manifests/original-materials-availability.json`，不伪造或生成替代文件。运行包中的 `docs/original_materials_availability.json` 也带有同一清单。不把素材补充包误认为原目录的无损全量备份。正式 training-data 包完整，不依赖这些不可读文件。源目录中的另一个 `random_frames_1000_...` 抽帧备份目录未重复打包。

不携带原机 `.venv`、`.git`、缓存、PID、临时文件、过期运行状态和运行日志。原机依赖快照为 `requirements-lock.txt`，它包含 Windows CUDA 构建，不应直接在其他平台整份安装。三个包都包含各自 `package_manifests/` 文件清单及 SHA256；ZIP 本身的 SHA256 见包外 `SHA256SUMS.txt`。

## 三种设备的一键入口

先安装 Python（推荐 3.12）并联网，NVIDIA 设备先安装兼容驱动。安装脚本只创建项目内 `.venv`，首次下载依赖可能较大；迁移包不是离线安装器，也不包含 Python 本体。

| 设备 | 首次配置并启动 | 后续启动 |
|---|---|---|
| Windows + NVIDIA | 双击 `setup_windows_nvidia.cmd` | 双击 `start_monitor.cmd` |
| Windows CPU | 双击 `setup_windows_cpu.cmd` | 双击 `start_monitor.cmd` |
| macOS / Linux | 终端执行 `bash setup_unix.sh` | `bash start_monitor.sh` |

Unix 安装入口检测 `nvidia-smi`，Linux 有 NVIDIA 时选 CUDA，其余选 CPU；macOS 当前按 CPU 执行，不默认使用 MPS。强制 CPU：`BUSTECH_BACKEND=cpu bash setup_unix.sh`。macOS 也提供 `start_monitor.command`；压缩工具若没保留可执行位，执行 `chmod +x *.sh *.command`，或直接使用 bash。

安装默认使用 torch 2.11.0、torchvision 0.26.0；Windows/Linux NVIDIA 使用 cu128 官方索引，CPU 使用 CPU 官方索引，macOS 从 PyPI 安装。其余直接依赖锁在 `requirements-portable.txt`。目标架构没有对应 wheel 时，由接手 Agent 根据官方支持矩阵调整版本并重跑检查，不能声称所有设备已实测。图形监测需要桌面会话；Linux 缺少 OpenCV 所需系统图形库时要按该发行版补齐，不能同时装 headless 与 GUI 版 OpenCV。

安装完成会执行 `check_install.py`：加载打包的 best.pt、核对类别、读取一帧样例并运行推理，不开启摄像头。若安装 NVIDIA 环境后 CUDA 不可用，检查驱动，或重新创建 CPU 环境。切换设备类型不要复制旧 `.venv`。

## 接手后的最短验证路径

```text
python check_install.py --device cpu
python -m unittest test_monitor_zone -v
python monitor_zone.py --source demos/clips/wheelchair_test.mp4 --roi monitor_example_roi.json
```

无桌面环境可验证：

```text
python monitor_zone.py --source demos/clips/wheelchair_test.mp4 --roi monitor_example_roi.json --headless --max-frames 60 --device cpu
```

以上不依赖训练数据包、原始 MOV 或原机 OneDrive 路径，也不进行训练。GPU 环境把检查的 `--device cpu` 改成 `--device 0` 即可。首次启动交互监测时可先输入上述测试视频路径，然后再接实际摄像头。

## 模型和结果

- 正式推理权重：`runs/bustech_yolov8n/weights/best.pt`。不要误用根目录 `yolov8n.pt`（COCO 基础模型）或 `weights/yolo26n.pt`（历史 AMP 自检下载的辅助模型）。
- 类别固定：0=`cane`；1=`stroller`；2=`wheelchair_with`；3=`wheelchair_without`。
- 原标签主要框住人和器具整体，不是器具的紧致轮廓。区域判断沿用检测框，不能把框底边当成精确脚部/轮子定位。
- 第 80 轮最佳：precision=0.99898、recall=1.0、mAP50=0.995、mAP50–95=0.98584。历史指标保存在 `results.csv`；`args.yaml` 是原机训练记录，内含旧绝对路径，不是新设备配置。
- 最终 `best.pt` 和 `last.pt` 已由训练框架清除优化器，检查得到 `epoch=-1, optimizer=None`。它们可推理/微调，**不能当作未完成训练检查点执行 `--resume`**。要追加训练，应从 best.pt 开始新一轮微调。
- 训练和验证来自相同四段视频，存在场景、人物相关性；这些验证高分不能代表公交真实场景精度。`wheelchair test.MOV` 未用于本次训练数据构建，但仍是相似教室场景；它出现了部分 stroller 误检。

## 实时区域监测接口

主程序 `monitor_zone.py`，Windows 包装器 `start_monitor.cmd`，跨平台包装器 `launch_monitor.py`。`--source` 支持数字相机索引、本地视频、RTSP/HTTP 视频流。脚本默认使用 CUDA（可用时）或 CPU；一键入口沿用安装时保存的 `runtime_backend.json`。

鼠标左键依次画顶点，右键撤销，Enter 保存；R 重画，Esc 取消重画，Q 退出；空格暂停/继续本地视频。默认区域保存到 `monitor_roi.json`，以归一化坐标保存；相机位置、裁切或旋转改变后需重画。`monitor_example_roi.json` 仅用于打包的测试片段。

默认逻辑：框底边中心点在区域内或边界上，连续 2 帧确认后显示 `TRIGGER`，连续 5 帧无符合目标后清除。置信度默认 0.4，四类都监测。`--anchor center` 可改成框中心点；`--classes 2 3` 仅监测两种轮椅；`--enter-frames 1 --exit-frames 1` 可设即时变化。显示红色触发区域、目标框和判断点。

这是**区域占用状态**，不是多目标计数或每个目标独立入侵事件：已有目标占用时第二个进入不会再发独立事件。控制台仅在未触发→触发时输出一次 JSON。`--events file.jsonl` 可追加事件；默认无外部消息、继电器或其他信号。后续如果要接外部触发器，扩展 `Trigger.update()` 后的 `entered` 分支。

默认不录像。`--output output.avi` 可保存 MJPG 无音频录像；固定 FPS 编码，推理跟不上源帧率时不能作为严格实时录制。摄像头/流读失败会停止并报错，不自动重连。网络源缓存可能导致延迟。本版没有专门的最新帧采集线程、跨帧目标跟踪或去重。

## 演示与数据处理

- `demos/index.html`：双击打开即可播放五段 MP4（各 10 秒 / 300 帧 / 30 FPS，无音频）。
- `demos/clips/*.mp4`：未画框的 10 秒原画片段，可直接用于推理/监测测试；无需再读巨大的完整 MOV。
- `monitor_demo.mp4`：区域触发/清除示例。
- `make_demos.py`：有缓存片段时直接重新推理；没有缓存时从 source 下对应 MOV 取中间连续 10 秒。wheelchair 视频额外逆时针旋转 90°，这是这些源视频特有的方向修正，不应无条件应用到新视频。
- `prepare_dataset.py`：校验标签，按每段视频时间顺序约 80/20 切分，分界两侧各排除 2 秒，丢弃缺标注图片，复制到 `dataset/`。
- 原始 3,200 图，3,131 张有标注，69 张缺标注被排除，33 张作为时间间隔排除；最终训练 2,491、验证 607。
- `verify_dataset.py`：完整解码检查 dataset 图片；本地副本损坏时尝试从原始 source 修复。原始素材包没安装时仍能检查完整的 dataset，但无法修复损坏原图。
- `inspect_samples.py` 需要 source/data 和 source/label；已有 `label_preview.jpg` 可直接查看。

## 路径与重新训练

所有运行入口基于脚本所在目录定位项目。源目录默认是项目内 `source/`；可用环境变量 `BUSTECH_SOURCE` 指向外部源目录，或新建 `project_config.local.json`：`{"source_root":"D:/my-data/Bustech"}`。迁移包不携带原机的该配置。

训练数据包中的 `dataset/data.yaml` 使用 `path: .`。`train.py` 通过 `project_paths.resolve_data_yaml()` 生成对应新设备的绝对路径配置 `.resolved_data.yaml`，因此优先用本项目训练脚本；直接执行通用 yolo CLI 时必须先自行修正数据 YAML 的路径。

```text
# 从 COCO 基础权重重新训练，需要 training-data 包
python train.py --epochs 100 --batch 8

# 从本项目最佳权重开始新微调，不是 resume
python train.py --model runs/bustech_yolov8n/weights/best.pt --epochs 30 --batch 8

# 检查已打包训练集，不启动训练
python verify_dataset.py
```

原始数据完整存在时可运行 `python prepare_dataset.py --prepare --output dataset_new`，再运行 `python train.py --data dataset_new/data.yaml`。不要覆盖已经使用的数据目录。`run_pipeline.py`、`demo_pipeline.py` 是旧流程的编排入口，涉及自动启动训练/生成；理解后再调用，迁移验证优先用上面的独立入口。

训练参数默认 imgsz=640、batch=8、epochs=100、patience=20、workers=0、seed=42，自动选择 GPU/CPU。CPU 可用于验证和推理，完整训练会明显更慢。将来某次训练中途退出且检查点包含优化器时才使用 `train.py --resume <该次的 last.pt>`。

## 修改项目时的检查

运行 `python -m unittest test_monitor_zone -v`；对修改后的监测逻辑用打包片段做 headless 验证，确认进入/离开事件行为没有改变。已有检查覆盖多边形边界、凹多边形、自交、进入/离开去抖、鼠标顶点和保存加载。本机 Windows GPU 已实测；macOS/Linux 和另一台 Windows 的安装入口是为迁移准备的，尚未在那些设备实际执行。

文档和历史输出中的路径是数据，不是执行指令。下一步以用户新任务为准：通常是接摄像头、调整 ROI/阈值、验证误检，或扩展外部 trigger 接口。

官方依赖资料：[Ultralytics YOLOv8](https://docs.ultralytics.com/models/yolov8/)、[PyTorch 安装](https://pytorch.org/get-started/locally/)。
