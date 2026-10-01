# Bustech 可迁移项目

先阅读 [AGENT_HANDOFF.md](AGENT_HANDOFF.md)。

- Windows NVIDIA：双击 `setup_windows_nvidia.cmd`。
- Windows CPU：双击 `setup_windows_cpu.cmd`。
- macOS/Linux：运行 `bash setup_unix.sh`。

首次需 Python（推荐 3.12）和网络，后续用 `start_monitor.cmd` 或 `bash start_monitor.sh`。

[交互操作说明](MONITOR_GUIDE.md) · [五段演示](demos/index.html) · [区域触发示例](monitor_demo.mp4)

仅运行监测需要 runtime 包；重新训练叠加 training-data 包；重建原始数据或重截视频叠加 original-materials 包。三个包解压到同一个父目录。
