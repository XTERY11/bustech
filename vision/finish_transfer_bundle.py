"""Finalize migration documentation and checksums after building the archives."""
import json
from pathlib import Path
import shutil
import zipfile
from build_transfer_bundle import archive
from project_paths import ROOT


def main():
    out = ROOT/'release'
    stage = out/'Bustech'
    details = json.loads((out/'original_materials_availability.json').read_text())
    missing = details['unavailable_originals']
    assert len(missing) == 104
    assert sum(p['path'].endswith('.jpg') for p in missing) == 102
    with zipfile.ZipFile(out/'Bustech-training-data.zip') as z:
        names = set(z.namelist())
        images = [n for n in names if n.startswith('Bustech/dataset/images/') and n.endswith('.jpg')]
        assert len(images) == 3098
        assert sum('/train/' in n for n in images) == 2491
        assert sum('/val/' in n for n in images) == 607
        assert all(n.replace('/images/','/labels/').removesuffix('.jpg')+'.txt' in names for n in images)
    with zipfile.ZipFile(out/'Bustech-original-materials.zip') as z:
        movies = [i for i in z.infolist() if i.filename.lower().endswith('.mov')]
        assert len(movies) == 5
        assert sum(i.file_size for i in movies) == 9441141119
    report = '''# 迁移验收记录

- 正式训练集：2,491 张训练图 + 607 张验证图；3,098 份标签，图片和标签一一匹配。
- 五个完整 MOV 已打包，合计 9,441,141,119 字节。
- 三个 ZIP 均通过完整 CRC 检查，每个文件有 SHA256 清单，ZIP 本身有 SHA256SUMS.txt。
- 核心运行包已解压至与原项目不同的目录；不携带本机 source 配置或 .venv。
- 异目录 CPU 模型加载与一帧预测通过；区域逻辑 5 项自动测试通过；60 帧 headless 监测正确触发。
- 异目录 dataset/data.yaml 和源素材路径解析通过。
- macOS/Linux 三个 Bash 入口通过语法检查，但尚未在 macOS/Linux 或另一台 Windows 上安装实测。
- 原始素材缺失：102 张未用于正式训练/验证的原图 + 2 个 frames.csv，原因是原机 OneDrive 返回读取错误。详见 original_materials_availability.json。训练数据包、权重、源码、示例视频均完整。
- 不包含原机虚拟环境、Git 元数据、临时缓存、过期日志/PID，以及源目录的重复抽帧备份目录。
'''
    (stage/'MIGRATION_REPORT.md').write_text(report,encoding='utf-8')
    shutil.copyfile(ROOT/'AGENT_HANDOFF.md',stage/'AGENT_HANDOFF.md')
    shutil.copyfile(ROOT/'AGENT_HANDOFF.md',out/'AGENT_HANDOFF.md')
    shutil.copyfile(out/'original_materials_availability.json',stage/'docs/original_materials_availability.json')
    shutil.copyfile(ROOT/'finish_transfer_bundle.py',stage/'finish_transfer_bundle.py')
    summary = json.loads((out/'package_summary.json').read_text())
    files = [(p,p.relative_to(stage).as_posix()) for p in stage.rglob('*') if p.is_file()]
    summary[0] = archive(out/'Bustech-runtime.zip',files,'runtime',True)
    (out/'package_summary.json').write_text(json.dumps(summary,indent=2),encoding='utf-8')
    (out/'SHA256SUMS.txt').write_text(''.join(f'{r["sha256"]}  {r["archive"]}\n' for r in summary),encoding='utf-8')
    readme = '''# 如何迁移 Bustech

把需要的 ZIP 复制到新设备，**都解压到同一个父目录**，合并为一个 Bustech 文件夹。

| 文件 | 用途 | 大小 |
|---|---|---|
'''
    for row,description in zip(summary,['运行、全部源码、权重、示例和交接文档；必需','完整训练/验证图和标签；重训时需要','五个完整原视频与可读原始素材；补充包']):
        readme += f'| [{row["archive"]}]({row["archive"]}) | {description} | {row["bytes"]/1e9:.3f} GB |\n'
    readme += '''
让新设备的 agent 先读 `Bustech/AGENT_HANDOFF.md`。本目录也提供该文档的单独副本。

三种首次配置并启动入口（需要安装 Python，推荐 3.12，首次需网络）：

- Windows NVIDIA：`setup_windows_nvidia.cmd`
- Windows CPU：`setup_windows_cpu.cmd`
- macOS/Linux：`bash setup_unix.sh`

只运行摄像头区域监测，只需 runtime 包。目标设备无需访问原机 OneDrive 路径。

校验：Windows PowerShell 可执行 `Get-FileHash .\\Bustech-runtime.zip -Algorithm SHA256`，对照 `SHA256SUMS.txt`。Linux 可用 `sha256sum -c SHA256SUMS.txt`；macOS 可用 `shasum -a 256 -c SHA256SUMS.txt`。未下载的可选包可单独校验所选文件。

原始素材补充包不是无损全量备份：102 张额外原图和 2 个 CSV 因 OneDrive 读取错误未能打包，见 `original_materials_availability.json`。这不影响完整训练数据包和推理功能。重复抽帧备份目录未打包。
'''
    (out/'START_HERE.md').write_text(readme,encoding='utf-8')
    shutil.copyfile(stage/'README.md',ROOT/'README.md')
    print(json.dumps(summary,indent=2),flush=True)


if __name__ == '__main__':
    main()
