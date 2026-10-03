# BusTech 交接文档（HANDOFF.md）

状态：2026-10-03 · 接口细节见 [PROMPT.md](PROMPT.md)

这份文档说明三件事：系统现在能做什么、别人怎样在自己的机器上跑起来、还剩哪两块没做完。
两块待办（[模块一：dashboard 界面调整](#4-待办模块一dashboard-界面调整)、[模块二：App 侧触发](#5-待办模块二app-侧触发)）目前只列出接口和已知问题，具体要求由负责人补充。

---

## 1. 系统现在能做什么

一位带辅具的乘客从预约到上车的完整过程，全程模拟，不控制任何真实车辆：

```
 App 预约 ──► 中枢 ──► 大模型推理一次（方案此时定好）
                │
 手机摄像头 ──► 视觉检测桥 ──► 触发一：辅具进入站台区域（到站）
                │                触发二：方案就绪后离开区域（上车）
                ▼
        dashboard：思考过程 | 实时画面 | 公交数字孪生
                ▼
        （App 读取同一份状态，向乘客显示指引 —— 尚未接入）
```

乘客旅程分四个阶段，由中枢统一维护，dashboard、孪生、App 看到的是同一个状态：

| 阶段 | 进入条件 | 大模型 | 公交孪生 | 给乘客的指引 |
|---|---|---|---|---|
| `IDLE` | 没有有效预约 | — | 待命 | 提示先预约 |
| `BOOKED` | App 发来预约 | **推理一次** | "已收到请求"，不放坡道 | 请前往站台上车点 |
| `AT_STOP` | 摄像头看到辅具进入站台区域 | 不调用，本地规则核对后立即执行 | 下蹲、开门、按方案伸坡道 | 上车指引 |
| `ON_BOARD` | 方案就绪且类别一致的乘客离开区域 | 不调用 | 剖面视角显示座位或轮椅位，收坡道、关门 | 车内座位指引 |

"握手"是系统内部的核对：预约的需求类别与摄像头看到的辅具类别一致才执行，乘客不需要操作。

### 1.1 三个模块之间的信号分配

三个模块只通过中枢交换信号，彼此不直接调用。App 和 dashboard 读的是同一份状态（`GET /api/state`，或订阅 `GET /api/events`），所以两边显示的阶段总是一致。

| 步骤 | 发出方 → 接口 | 信号内容 | 中枢做什么 | dashboard 显示 | App 显示 | 现状 |
|---|---|---|---|---|---|---|
| ① 乘客选择类别 | App → `POST /api/booking` | `accessibility_need`：`WHEELCHAIR` / `STROLLER` / `CANE` …，以及需要的协助 | 阶段进入 `BOOKED`；**大模型推理一次**（没有 key 时用固定规则），方案此时定好 | 思考过程、动作计划；孪生"已收到请求" | 第一轮指引：请前往站台上车点（`journey.guidance`） | 接口已通；App 未接入，用 curl 代替 |
| ② 触发信号一：进入站台 | 视觉 → `POST /api/perception` | `zone.event = "enter"`，`zone.triggered = true`，区域内辅具的类别 | 阶段进入 `AT_STOP`；核对类别是否与预约一致，一致则按规则核对后执行（**不再调用大模型**） | 一致：孪生下蹲、开门、伸坡道；不一致：车继续等待；实时画面标出触发 | 第二轮指引：已识别你到站 / 请上车 | 已通 |
| 占用期间 | 视觉 → 同上 | 每 2 秒一次 `zone.event = "present"` | 只刷新时间，不改变阶段 | — | — | 已通 |
| ③ 触发信号二：离开站台 | 视觉 → 同上 | `zone.event = "exit"`，`zone.triggered = false`，`zone.left` 为刚才在区域里的类别 | 方案为 READY 且类别一致：阶段进入 `ON_BOARD`，座位用规划器按车厢空位分配的 `boarding_target`（轮椅 → 轮椅位，其他 → 空座，如 `S03`），预约用完；`ON_BOARD` 保持到下一次预约 | 按类别的车内引导动画：乘客（轮椅 / 手杖 / 婴儿车等）沿高亮路线走到分配的位置，停在等待安全员确认；思考面板保留预约时的推理 | 第三轮指引：座位编号 + 上车动画 | 中枢和 dashboard 已通；App 未接入 |
| 取消 | App → `POST /api/booking` | `active: false` | 阶段回到 `IDLE` | 孪生待命 | 提示先预约 | 已通 |

阶段只在中枢里推进，App 和 dashboard 都不需要自己判断流程：读到 `journey.stage` 切换画面，显示（或朗读）`journey.guidance`，座位在 `journey.seat`。

---

## 2. 已有的方法

### 2.1 视觉识别（`vision/`）

- **识别对象**：轮椅、婴儿车、手杖三类；画面里的人单独标出，只显示不上报。
- **为什么不直接用训练好的 `best.pt`**：它的标注是"人 + 辅具"整体框，训练数据只有一个房间、少数几个人、没有"只有人"的画面。换场地后会把普通行人判成辅具，对没见过的衣着漏检，轮椅和婴儿车混淆。权重没有改动，但它现在只负责给"轮椅还是婴儿车"投票。
- **实际做法**：用开放词表模型（YOLO-World）在整幅画面上找出人、带轮辅具和手杖。
  - 每台辅具一条轨迹，类别的票记在辅具上，所以一台辅具只有一个框、一个标签。
  - 辅具"有人带着"才算数：有成年人坐在里面（姿态检测判断），或被身边的人带离了原来停放的位置。停着的辅具旁边站多少人都不算。
  - 手杖按人逐帧判断：必须被人握着（贴着人、从手的高度伸到脚边）。
- **两个触发**：到站是辅具或带着它的人与站台区域重叠并持续 0.3 秒；占用期间只要区域里还有人就保持；区域空 2 秒后解除，如果此前方案已就绪且类别一致，就是"上车"。
- **调试工具**：每次触发自动存图（`vision/trigger_snapshots/`）；`record_clip.py` 录原始画面；`yolo_bridge.py --source <录像> --realtime` 按实时速度回放，改逻辑后先对着录像验证。
- 主要文件：`yolo_bridge.py`（检测桥）、`aid_verifier.py`（跟踪与判定逻辑）、`monitor_zone.py`（只用来画站台区域）。

### 2.2 中枢与决策（`dashboard/backend/`）

- `hub.mjs`：接收 App 预约和视觉信号，去重、合并、触发规划。
- `planner/`：安全策略 + DeepSeek 调用 + 动作校验。大模型的输出必须通过策略校验，否则回退到规则结果。
- `journey.mjs`：乘客旅程状态机和每个阶段的指引文字。
- 大模型只在预约到达时调用；之后的视觉信号只用本地规则核对方案是否仍成立。

### 2.3 dashboard 页面（`dashboard/app/`）

- 首屏：思考（逐词显示）、通道状态条（含旅程阶段）、实时画面、公交孪生。
- 右上角 "Show controls & details" 展开：预设场景、信号控制、诊断、完整动作计划。

### 2.4 公交数字孪生（`twin/`）

- 外观、车门、坡道、下蹲，以及车厢内饰（16 个座位 + 轮椅位，剖面和车内视角）。
- 以单个 HTML 文件嵌入 dashboard，只接收状态帧，不回写。改完 `twin/` 后运行 `bash twin/sync_to_dashboard.sh` 重新打包。

### 2.5 验证过的范围

| 内容 | 验证方式 |
|---|---|
| 三类辅具识别、不误判单纯的人和停着的辅具 | 真实手机摄像头多轮测试 + 两段现场录像回放 |
| 到站与握手 | 真实摄像头 + DeepSeek 跑过一轮：轮椅一致并执行，婴儿车和手杖不一致不执行 |
| 上车后半段（剖面视角、座位、收坡道、关门） | 模拟信号在浏览器里验证；真实摄像头下只确认了触发，动画没有完整看完 |
| 完整开环（预约 → 大模型 → 触发一 → 触发二 → 上车动画） | 10 月 3 日用回放模式（3.7 节）+ DeepSeek 完整跑通：两次婴儿车到站不一致、车不开门；轮椅到站一致、开门伸坡道；离开后进入 `ON_BOARD`、分配轮椅位、动画播完；之后进站的手杖乘客不打断 |
| 自动化测试 | dashboard 47 项、视觉 21 项、孪生测试，全部通过 |

---

## 3. 怎样启动（复现步骤）

### 3.1 环境要求

- Python 3.10–3.12，Node.js 22.13 或更高。macOS（Apple Silicon）上验证过。
- 手机摄像头：手机装 DroidCam 类应用，电脑和手机在同一网络（如手机热点），视频地址形如 `http://172.20.10.4:4747/video`。

### 3.2 第一次安装

```bash
git clone git@github.com:XTERY11/bustech.git && cd bustech
cd vision && python3 setup_environment.py && cd ..     # 创建 vision/.venv 并安装依赖
cd dashboard && npm ci && cd ..
```

生成效果更好的确认模型（约 140 MB，不在仓库里，每台机器做一次，会下载约 480 MB）：

```bash
cd vision && .venv/bin/python aid_verifier.py x && cd ..
```

不做这一步也能运行，会使用仓库自带的小号模型，但手杖和较远的辅具识别明显变差。

### 3.3 不用摄像头，先跑通

```bash
bash start_demo.sh
```

用仓库自带的测试视频（一台有人坐着的轮椅循环播放），离线规则模式，不需要 key。打开 <http://127.0.0.1:3000>。按 `Ctrl + C` 停止全部服务。

### 3.4 真实摄像头

1. 固定好手机位置，画一次站台区域（之后手机一动就要重画）：
   ```bash
   cd vision && .venv/bin/python monitor_zone.py --source "http://172.20.10.4:4747/video"
   ```
   在窗口里：按 `R` 清掉旧区域 → 左键点出区域的角 → 按回车保存（出现 "Region saved"）→ 按 `Q` 退出。
   这个窗口显示的是没有上述逻辑的原始检测，只用来画区域。
2. 启动：
   ```bash
   BRIDGE_WINDOW=1 bash start_demo.sh "http://172.20.10.4:4747/video"
   ```
   `BRIDGE_WINDOW=1` 弹出带标注的实时画面窗口；加 `BRIDGE_RECORD=1` 会同时把原始画面录到 `vision/recordings/`。

### 3.5 接入 DeepSeek

key 只通过环境变量传入，不要写进文件或提交。在同一个终端窗口里：

```bash
read -s DEEPSEEK_API_KEY && export DEEPSEEK_API_KEY     # 粘贴 key 后回车，输入不显示
BRIDGE_WINDOW=1 bash start_demo.sh "http://172.20.10.4:4747/video"
```

启动后 `curl http://127.0.0.1:8787/api/health` 应显示 `"llm_configured":true`。在 dashboard 展开面板里把 Generation mode 选为 "DeepSeek · Single call"（默认即是）。

### 3.6 没有 App 时，模拟一位乘客

App 还没接入，用下面的命令代替它发预约（把 `WHEELCHAIR` 换成 `STROLLER`、`CANE`、`VISUAL_ASSISTANCE` 等即可测别的需求）：

```bash
curl -X POST http://127.0.0.1:8787/api/booking -H 'Content-Type: application/json' \
  -d '{"event_id":"app-'$(date +%s)'","observed_at":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'","payload":{"active":true,"intent":"BOARDING","route_id":"DEMO_ROUTE","stop_id":"DEMO_STOP","accessibility_need":"WHEELCHAIR","ramp_preference":"REQUESTED","assistance_requested":["WHEELCHAIR_RAMP","ADDITIONAL_BOARDING_TIME"],"preferred_interaction":"BOTH","language":"en-SG"}}'
```

之后带着对应的辅具走进站台区域、停几秒、再离开，就是一次完整旅程。连摄像头也没有时，可以用同样的方式模拟视觉信号：

```bash
# 到站
curl -X POST http://127.0.0.1:8787/api/perception -H 'Content-Type: application/json' \
  -d '{"event_id":"enter-'$(date +%s)'","observed_at":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'","payload":{"yolo_detections":[{"label":"WHEELCHAIR","confidence":0.95}],"target_match_confirmed":true,"zone":{"triggered":true,"roi_id":"manual","event":"enter"}}}'
# 上车（离开区域）
curl -X POST http://127.0.0.1:8787/api/perception -H 'Content-Type: application/json' \
  -d '{"event_id":"exit-'$(date +%s)'","observed_at":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'","payload":{"yolo_detections":[],"target_match_confirmed":false,"zone":{"triggered":false,"roi_id":"manual","event":"exit","left":["WHEELCHAIR"]}}}'
```

查看当前阶段和指引：`curl http://127.0.0.1:8787/api/state`，看其中的 `journey`。

### 3.7 用录像代替摄像头（回放模式，联调用）

不需要手机、摄像头和 YOLO 模型，适合做 App 和 dashboard 的同学联调。回放程序 `vision/replay_bridge.py` 与真实检测桥的端口和接口完全相同：画面同样在 8790 端口，信号同样发到中枢的 `/api/perception`，中枢、dashboard 和 App 分不出两者。

仓库自带一段采集：`demos/captures/venue_live_172729/`，内容是 10 月 2 日现场实测的录像（轮椅进入站台区域、停留、离开）经过真实检测桥处理后的带标注画面，以及当时发给中枢的每一条信号和时间。

```bash
bash start_demo.sh demos/captures/venue_live_172729
```

启动后画面停在第一帧，**等收到预约才开始播放**：用 App（或 3.6 节的预约命令）提交一次预约，画面开始播放，到时间自动发出触发信号一和触发信号二。一遍放完后回到第一帧，等下一次预约。想不等预约直接循环播放：`AFTER_BOOKING=0 bash start_demo.sh demos/captures/venue_live_172729`。

用自己的录像做一段新的采集（需要视觉环境和模型）：

```bash
cd vision
.venv/bin/python yolo_bridge.py --source recordings/<录像>.mp4 --roi monitor_roi.json \
  --no-window --no-signal --capture ../demos/captures/<名字>
```

采集目录里是 `annotated.mp4`（带框和区域的画面）和 `signals.jsonl`（每条信号及其在视频中的秒数）。真实摄像头运行时也可以加 `--capture` 同时采集。

### 3.8 常见问题

| 现象 | 原因和处理 |
|---|---|
| 检测桥报 `Connection refused` | 手机上的摄像头应用不在前台或已锁屏。调到前台，关闭自动锁屏 |
| 报 `Operation timed out` / `No route to host` | 电脑和手机不在同一网络；或 macOS 未允许该终端访问本地网络（系统设置 → 隐私与安全性 → 本地网络） |
| 画区域的窗口和检测桥互相连不上 | 摄像头应用同一时间只允许一个连接，画完区域先按 `Q` 退出 |
| 出了框但不触发 | 区域画得太小或贴着画面下沿，重画大一些 |
| dashboard 显示 key 未配置 | 环境变量只在输入它的那个终端窗口里有效，启动命令要在同一个窗口运行 |
| 端口被占用 | `DASHBOARD_PORT=3100 BRIDGE_PORT=8887 VISION_PORT=8890 bash start_demo.sh` |

### 3.9 测试

```bash
cd dashboard && npm test                                               # 47 项
cd vision && .venv/bin/python -m unittest test_aid_verifier test_monitor_zone   # 21 项
cd twin && npm ci && npm test
```

---

## 4. 待办模块一：dashboard 界面调整

**负责人**：待定

**范围**：`dashboard/app/`（页面、样式、孪生面板）。不改 `backend/` 的接口；需要新数据时先和中枢负责人确认，并更新 `PROMPT.md`。

**可以直接用的数据**：页面已经拿到 `journey`（阶段、是否一致、座位、指引）、`result`（状态、动作计划、给乘客的话、生成来源和耗时）、`summary`（思考摘要）、实时画面和孪生的状态。

**具体要改什么**：

- [ ] （待填充）
- [ ] （待填充）
- [ ] （待填充）

**已知问题，供参考**：

- 乘客旅程在首屏只是通道状态条里的一格，四个阶段的进度不够醒目。
- 思考面板的逐词显示会被视觉心跳（每 2 秒一次）重新触发，乘客在站台时常常只显示开头一两个词。
- 车内座位指引只显示在孪生下方的"车外显示屏"里，没有单独的位置。

**验收**（负责人可补充）：

- `npm test` 与 `npm run lint` 通过。
- 用 3.6 节的命令走一遍预约 → 到站 → 上车，页面各阶段显示正确。

---

## 5. 待办模块二：App 侧触发

**负责人**：待定 · 参考仓库：`apinfiniteloop/buspulse-sg`（私有，尚未对接）

**目标**：乘客在手机上提交预约，并在手机上按阶段看到（或听到）系统给自己的指引。App 是整条流程的第一个触发。

**接口已经就绪，不需要改后端**（详见 `PROMPT.md` 2.4 和 2.5b 节）：

| 方向 | 接口 | 说明 |
|---|---|---|
| App → 中枢 | `POST /api/booking` | 提交或取消预约，请求体格式见 3.6 节的示例 |
| 中枢 → App | `GET /api/state` 或订阅 `GET /api/events` | 读取 `journey.stage` 切换画面，显示或朗读 `journey.guidance` |

App 不需要自己推断流程，也不需要在到站时让乘客操作，到站由摄像头判定。

**具体要做什么**：

- [ ] （待填充）
- [ ] （待填充）
- [ ] （待填充）

**已知问题，供参考**：

- 手机访问需要局域网模式：`LAN=1 bash start_demo.sh ...` 会打印 IP 和访问 token，请求要带 `Authorization: Bearer <token>`。
- 网页形态的 App 会受跨域限制，它的来源地址必须加入中枢的 `ALLOWED_ORIGINS`；中枢是 `http://`，App 如果部署在 `https://` 会被浏览器拦截。
- 浏览器原生 `EventSource` 不能带 token，要用 `fetch` 读流（可参考 `dashboard/app/live-client.ts`）或改用轮询。
- 没有可见辅具的乘客（如听障）摄像头无法发现其到站，流程会停在 `BOOKED`。可以给 App 加一个"我已到站"的后备按钮，这需要中枢增加对应的接口。
- 预约 5 分钟后过期。

**与目标流程对照，App 侧还缺的部分**：

- 选择类别并提交预约的界面（对应流程 ①）。
- 按 `journey.stage` 显示三轮指引：已收到预约 → 已识别你到站 → 上车与座位（对应 ①②③），文字直接用 `journey.guidance`。
- 上车动画和座位编号（对应 ③）：座位在 `journey.seat`（`WHEELCHAIR_BAY` 或 `S02` 这类编号），动画按类别做，或嵌入 dashboard 已有的孪生。
- 联调不需要摄像头：`bash start_demo.sh demos/captures/venue_live_172729`，App 提交预约后回放自动开始，约 8 秒后第一次到站。

**验收**（负责人可补充）：

- 手机提交预约后，dashboard 通道条显示该预约，Thinking 面板出现大模型的推理。
- 带对应辅具到站、再离开，手机上依次显示三个阶段的指引。
- 取消预约后阶段回到 `IDLE`。

---

## 6. 协作约定

- 接口以 `PROMPT.md` 第 2 节为准，改接口先改文档再通知相关模块。
- 不要修改 `vision/monitor_zone.py`；`dashboard/backend/hub.mjs` 的改动必须带测试。
- key 和 token 只通过环境变量传入，不写进文件，不提交。
- 合并前跑 3.9 节的测试。
