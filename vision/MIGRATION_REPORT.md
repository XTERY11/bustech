# 迁移验收记录

- 正式训练集：2,491 张训练图 + 607 张验证图；3,098 份标签，图片和标签一一匹配。
- 五个完整 MOV 已打包，合计 9,441,141,119 字节。
- 三个 ZIP 均通过完整 CRC 检查，每个文件有 SHA256 清单，ZIP 本身有 SHA256SUMS.txt。
- 核心运行包已解压至与原项目不同的目录；不携带本机 source 配置或 .venv。
- 异目录 CPU 模型加载与一帧预测通过；区域逻辑 5 项自动测试通过；60 帧 headless 监测正确触发。
- 异目录 dataset/data.yaml 和源素材路径解析通过。
- macOS/Linux 三个 Bash 入口通过语法检查，但尚未在 macOS/Linux 或另一台 Windows 上安装实测。
- 原始素材缺失：102 张未用于正式训练/验证的原图 + 2 个 frames.csv，原因是原机 OneDrive 返回读取错误。详见 original_materials_availability.json。训练数据包、权重、源码、示例视频均完整。
- 不包含原机虚拟环境、Git 元数据、临时缓存、过期日志/PID，以及源目录的重复抽帧备份目录。
