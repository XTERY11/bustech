# BusTech 交接文档（HANDOFF.md）

状态：v0.6 联调开发（2026-10-03）· 已同步 `main@353765a` · 接口细节见 [PROMPT.md](PROMPT.md)

第 1–6 节保留原有启动、App 兼容与历史验证说明；最新握手、座位、广播和分段导航行为以第 7–9 节及 `PROMPT.md` 顶部的 v0.4/v0.5/v0.6 补充为准。v0.5 DeepSeek 验收记录在 7.5 节；历史实拍验证不代表本次改动已经用真实摄像头重新验收。

这份文档说明三件事：系统现在能做什么、别人怎样在自己的机器上跑起来、还剩哪两块没做完。
App 侧（需求、现状、要做的事、衔接方式、小修改改哪里）单独写在 [HANDOFF-APP.md](HANDOFF-APP.md)。
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
| ③ 触发信号二：离开站台 | 视觉 → 同上 | `zone.event = "exit"`，`zone.triggered = false`，`zone.left` 为刚才在区域里的类别，`zone.boarding` 为是否停留后朝车走去，`zone.dwell_seconds` 为停留时长 | 方案为 READY、类别一致且 `boarding` 不为 false：阶段进入 `ON_BOARD`，座位用规划器按车厢空位分配的 `boarding_target`（轮椅 → 轮椅位，其他 → 空座，如 `S03`），预约用完；`ON_BOARD` 保持到下一次预约 | 按类别的车内引导动画：乘客（轮椅 / 手杖 / 婴儿车等）沿高亮路线走到分配的位置，停在等待安全员确认；思考面板保留预约时的推理 | 第三轮指引：座位编号 + 上车动画 | 中枢和 dashboard 已通；App 未接入 |
| 取消 | App → `POST /api/booking` | `active: false` | 阶段回到 `IDLE` | 孪生待命 | 提示先预约 | 已通 |

上车动画有两种触发方式：完整流程里由触发信号二自动播放；dashboard 孪生面板下方的 "Preview boarding" 按钮可以单独演示（不依赖视觉，便于各模块解耦展示）。

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
- **两个触发**：到站是辅具或带着它的人与站台区域重叠并持续 0.3 秒；占用期间只要区域里还有人就保持；区域空 2 秒后解除。解除时判断去向：在区域里停够 2 秒、然后朝车的方向（默认往画面深处）离开才算上车；路过、从侧面或朝镜头离开都不算。方案已就绪、类别一致且判为上车，才进入 `ON_BOARD`。
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

仓库自带采集 `demos/captures/venue/`，来自 10 月 2 日现场实测录像，经真实检测桥处理，按辅具切成三段：`wheelchair/`、`stroller/`、`cane/`（各 15–18 秒，含带标注的画面和当时发给中枢的每一条信号）。回放按预约的需求类别自动选对应的一段：预约后约 5 秒进站（触发一），约 15 秒进入上车阶段（触发二 + 进站动画播完），放完停在最后一帧等下一次预约。每遍使用新的访问编号。

```bash
bash start_demo.sh demos/captures/venue
```

启动后画面停在第一帧，**等收到预约才开始播放**：用 App（或 3.6 节的预约命令）提交一次预约，画面开始播放，到时间自动发出触发信号一和触发信号二。一遍放完后回到第一帧，等下一次预约。想不等预约直接循环播放：`AFTER_BOOKING=0 bash start_demo.sh demos/captures/venue`。

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

- [x] `codex/main-ui-refresh`（基于 `main@15a764d`）：Signal 只显示中枢实际收到的预约类别、坡道偏好、协助需求和预约状态，不用默认预设冒充 App 输入；折叠区的 App booking 通道使用同一收据判定。
- [x] 保留 LLM Agent: Thinking、Sense: CV-Based Live Detection 和 Bus digital twin；Camera 与孪生同行。移除多余标题说明和四个摘要指标，Live channels、重跑按钮及完整诊断归入 controls & details。
- [x] 孪生外层只保留可滚动的 External display；`hud=dashboard` 只移除 iframe 内六步列表及重复显示条。独立孪生 HUD、动作/动画、后端与 App 接口不变。
- [x] 按框架分为 Signal（橙色）、Sense（蓝色）、Support（粉色），使用深色侧边栏。Overview 中 Camera 与孪生同行、Signal 与简短推理在下方；App booking、Live detection、LLM Agent、Digital twin 可切换独立大视图。
- [x] 预约使用图标和短标签，Route/Stop 等默认折叠；Overview 仅显示首条真实决策摘要，Full reasoning 展示全部摘要。回放、重播、视频连接设置随 controls & details 展开；视图切换只改 CSS，不重新挂载 iframe 或请求模型。
- [x] 孪生宽屏取景（宽高比 > 2.4）适度靠近整车，最多 28%；常规比例和 Interior 取景不变。

**已知问题，供参考**：

- Signal 的状态随预约、到站、上车、取消或过期同步更新；取消/过期反馈留在 Signal，上车导航留在 External display，不重复占用左栏；完整三步进度保留在折叠区。
- 逐词显示现在按摘要内容稳定计时，同内容心跳不再重启动画。
- 侧栏按展示要求写为 Bus App Connected，实际反映 dashboard 与中枢的 SSE 连接，不是手机在线心跳。预约通道也可由 curl 或回放按钮模拟。

**验收**（负责人可补充）：

- Dashboard 123 项、构建后 HTML 渲染 1 项、Twin 16 项及类型检查、前端/后端/测试 ESLint 通过；Next 与 Vinext 构建通过。
- 侧边栏五个视图在浏览器确认；完整推理保留三条摘要，切换过程中 iframe 保持单实例。390px 窄屏页面无水平溢出，折叠区通道卡改为单列。Next 构建使用 Webpack（本地共享依赖软链接不适配 Turbopack）。
- 2026-10-03 使用录制视频 + 真实 DeepSeek Single 验证预约 → 到站 → 上车，`meta.source=llm`、`validation_passed=true`。浏览器确认红框两处和外层动作列表不存在，Live channels 只在展开折叠区后显示；不代表实物摄像头或手机重新验收。

---

## 5. 待办模块二：App 侧触发

**现状（2026-10-03）**：iOS App 已在 `app/`，已改为跟随中枢旅程显示三轮指引并嵌入公交孪生，尚未用 Xcode 编译。以 [HANDOFF-APP.md](HANDOFF-APP.md) 为准，本节以下内容是早期记录。

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
- 联调不需要摄像头：`bash start_demo.sh demos/captures/venue`，App 提交预约后回放自动开始，约 8 秒后第一次到站。

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

---

## 7. v0.4：CV、App、dashboard 的三轮反馈

### 7.1 谁发送信号，谁决定阶段

中枢是旅程状态的唯一来源。App 提交乘客自选的需求，CV 只上报区域观察；dashboard 和 App 读取同一份指引、座位目标和动画描述。乘客不需要重复点击到站或上车。

| 轮次 | 输入 | 中枢处理 | App 与 dashboard 的共同输出 |
|---|---|---|---|
| 第一轮：预约 | App → `POST /api/booking` | 记录有效需求，以 LLM 或规则生成并校验方案；进入 `BOOKED` | 请前往站台标记的上车点；方案就绪尚不执行车辆准备 |
| 第二轮：到站 | CV → `enter`，占用期间 → `present` | 检查已确认、置信度 ≥0.75、当前预约类别一致；信号 1 绑定本次区域访问 | 已识别到站；启动模拟公交进站与准备动画，按校验后的动作开门、下蹲、处理坡道 |
| 第三轮：离开区域 | CV → 明确 `exit`，带 `left` | 核对同次访问和类别；规划或准备未完成时保留 `pending_exit`，就绪后进入 `ON_BOARD` | 播放上车与车内指引，显示分配位置；当前预约完成后不再匹配下一位到站乘客 |

进入区域后的公交进站展示为 4200 ms，整个到站准备阶段为 10000 ms。`READY` 指方案符合模拟策略；动画仍由中枢的旅程阶段和计时驱动。CV 的 `exit` 只表示 ROI 已清空，不是已坐好、已系安全带或已固定轮椅的真实确认，动画也不构成发车授权。

`zone.visit_id` 为可选字段，新检测桥每次区域激活生成 12 位 UUID，并在本次 `enter/present/exit` 中保持一致。它关联触发 1 和触发 2，不代表个人身份。既有 CV 输入仍可使用原 `event/roi_id/left`；接入新版后应发送访问编号，避免把不同次区域访问拼接成一次旅程。“即将离开”暂未新增，仍使用既有的离开事件。

### 7.2 需求、动作与座位

App 的输入信封和预约字段保持兼容：`accessibility_need` 表示需求类别，`assistance_requested` 与 `ramp_preference` 表示具体要求。普通乘客请求坡道不会因此被改成轮椅乘客。

动作枚举从 17 项扩展为 18 项，新增 `GUIDE_PASSENGER_TO_ASSIGNED_PLACE`。该动作位于 `WAIT_FOR_BOARDING_CONFIRMATION` 与 `WAIT_FOR_SEATED_AND_BELTED_CONFIRMATION` 之间，由服务端生成 `{target_type, target_id}` 参数。

`Result.boarding_target` 是目标的唯一来源：

```ts
null
// 或
{ type: 'SEAT', id: 'S01' /* … 'S16' */ }
// 或
{ type: 'WHEELCHAIR_BAY', id: 'WHEELCHAIR_BAY' }
```

客舱空位来自模拟的 `vehicle_context.cabin`，而不是现场座位传感器。中枢把预约信封的 `event_id` 注入只读 `booking_event_id`，策略用该 ID 在空位中稳定分配；同一预约的重试或重跑保留同一目标，新预约可分配不同空位。App 不需要增加 `booking_event_id` 请求字段，也不要把每次规划的 `request_id` 当作座位随机种子。轮椅只分配轮椅区，已占用位置不重新分配给当前乘客；无可用位置时按策略提示等待协助。

LLM 返回的目标必须与可信策略一致。显示目标和执行动画使用通过校验的 Result，不在 App 或孪生中另行挑座位。

### 7.3 SSE 与客户端接入

原来的 `GET /api/state`、`GET /api/events`、`POST /api/booking` 和 `POST /api/perception` 均保留。`journey.stage/need/labels/matched/seat/guidance` 保留，新增 `journey_id/revision/completed/pending_exit/boarding_target/animation`。`journey_id` 来源于预约事件 ID。

```ts
animation: null | {
  id: string;
  phase: 'arrival' | 'boarding';
  aid: string;
  started_at: number;  // 中枢 epoch ms
  duration_ms: number;
  target: Result['boarding_target'];
}
```

每次旅程转换、规划完成、取消或过期均广播完整 `snapshot`。保留原 `result` 事件，数据为 `{run_id,result,snapshot}`；新增 `navigation` 阶段事件，数据为 `{navigation,snapshot}`，其中 `navigation` 为 `{id,revision,phase,destination,instruction,simulated,animation}`。客户端优先应用随事件附带的完整快照，使用 `journey.guidance` 给乘客显示指引；评委页面额外展示 `summary` 中的决策摘要。

客户端以 `animation.id` 去重，并根据 `started_at/duration_ms` 恢复剩余进度。心跳、重复信封和 SSE 重连不能重新播放整段动画。`result.passenger_communication` 继续保留供旧 App 读取；新 App 应读取 `journey.guidance`，以区分预约、到站和车内指引。

乘客 App 是独立项目，本仓库不实现手机页面。中枢按现有 HTTP/SSE 连接下发 navigation 与旅程快照，不对手机项目进行 UI 改动。外部 App 按第 5 节配置中枢地址、Bearer token、来源放行及 HTTP/HTTPS 后，读取本节的新增可选数据。

### 7.4 CV 投递可靠性

检测桥不读取预约或 READY，匹配由中枢完成。其有序队列在后台投递：失败时保留原 ID、观察时间和内容重试；旧事件确认后才发送新事件。相邻未发送的同次 `present` 可合并，`enter/exit` 和已尝试过的信封不可替换。

`GET :8790/health` 新增 `pending_signals`、`signal_error`，`last_signal` 表示真正收到中枢 ACK 的事件。诊断不暴露 token。队列保存在进程内，停止时报告未送达数，但不跨重启保存。区域内旁观者仍会延迟现有的清空事件；访问编号不解决逐人身份识别。

### 7.5 本轮验收记录

- 已完成视觉纯逻辑测试：`python -m unittest test_aid_verifier test_monitor_zone test_signal_delivery -v`，31 项通过；另用测试视频无窗口、无上报处理 120 帧，未做实物摄像头验收。
- dashboard 81 项回归测试、Twin 12 项测试通过，包含公交沿车头方向进站和轮胎滚动方向校验。两份孪生单文件已同步，各约 1.35 MB。
- 真实 `deepseek-flash` / `single`：带 token 的 HTTP/SSE 完成 WHEELCHAIR、CANE、STROLLER、VISUAL_ASSISTANCE 预约 → TO_STOP → CV enter → WAIT_AT_STOP → CV exit → 座位/轮椅区分段导航。四类分别调用一次模型，`meta.source=llm`、`validation_passed=true`；CV 不增加调用。CV 输入是模拟 HTTP 信号，未做实物摄像头验收。
- 可重复运行：`cd dashboard && node scripts/check-journey.mjs --key-stdin`（隐藏输入密钥，只存内存；产生四次真实模型调用，rules/fallback 不能通过检查）。
- 浏览器另用真实模型完成一次 CANE 预约与模拟 CV 触发，服务端下发 S03 指引，dashboard 同步显示。桌面 YOLO/Twin 并排已检查。手机页面归独立项目，不在本次交付范围；未宣称实际 App 已适配。
- 等待中的预约 5 分钟失效；已消费的模拟上车旅程保留原目标，不被 TTL 或强制 rerun 改到另一座位。取消不释放已经使用的模拟位置；重启中枢重置演示车厢。真实安全确认和发车控制未实现。

## 8. v0.5：LLM 生成车内分段指引

不是仅告诉乘客“去 S03”。服务端按 `cabinRoute.mjs` 中与孪生一致的模拟地图，先计算从车门内侧、面向车内开始的直行距离和相对左右转。LLM 在同一轮动作规划中生成 `navigation_steps` 英文文字，不能改动目标、步序、距离或方向；通过校验后成为 `Result.cabin_navigation`。

`navigation.cabin_route` 在规划完成后即可下发，`navigation.steps` 在上车阶段下发具体指引，`instruction` 是步骤文字。单入口 S03 示例：直行约 0.9 m → 右转 → 直行约 0.7 m → 右转 → 直行约 0.5 m → 停下等安全员协助。完整字段见 `PROMPT.md` v0.5 与 `dashboard/docs/COMMUNICATION.md`。手机 UI 由独立项目负责，本仓库只通过既有 SSE/state 接口发送。

没有乘客实时位置及逐步回执；这些近似距离只用于模拟地图路线说明，不自动宣称某一步已真实完成，也不承诺可独立引导盲人在真实公交内避障。公交模型车头朝 −X，进站动画应由 +X 侧沿 −X 驶入，而不是倒车。

### 8.1 最新 main 的流程补充（2026-10-03）

- 触发二带上车意图：`zone.boarding=false`（路过、从侧面或朝镜头离开）不进入上车阶段，旅程回到 `BOOKED`，`reason` 为 `not_boarding`。
- dashboard 保留手动的 "Preview boarding" 按钮，只在本地播放上车动画，不改中枢状态；完整流程仍由触发二自动播放。
- 一次旅程完成后，下一次预约对应一辆新的模拟公交，上一位乘客用过的座位或轮椅位重新空出（原分支需要重启中枢）。未完成的当前公交不会清空占用。
- 检测桥在一次进站期间按类别保留见过的最高置信度，辅具被身体挡住时不会掉到中枢的 0.75 门槛以下。
- iOS App 在 `app/`，对接说明见 `HANDOFF-APP.md` 和 `app/docs/hub-v05-gap.md`。
- 现场操作顺序见 `RUNBOOK.md`：预约 → 匹配进入 ROI → 等 10 秒公交准备 → 朝车离开。该手册中的上车动画约 16 秒；本分支 STROLLER 分离展示为 22 秒。

## 9. v0.6：婴儿车与乘客分离

婴儿车先停入空轮椅区，乘客优先走到附近第一排 S02/S03 的空座坐下。两座都满后按距离依次使用 S05/S06、S08/S09，只有上一层无空座才选下一层；这些是已有导航支持的低地板靠过道座位，不扩展到靠窗穿座或后排台阶。模型输出同时包含乘客 `boarding_target` 和推车 `equipment_target`；车内分段路线包含 `PARK_STROLLER`，不是直接把推车带到座位。六座都满、轮椅区或 F01 占用时等待安全员。轮椅乘客保持人椅一体，直接留在轮椅区。

通过现有 SSE/state 向手机发送两个目标和完整步骤；App 源码已同步至 `app/`，本次不改 App UI。Twin 新增可选 `passengerJourney.equipmentDestination`，22 秒婴儿车上车展示包含可见的停车停顿与分离，乘客坐下后推车仍留在轮椅区。已消费旅程同时占用停车区和座位；按最新 main 的一次一位乘客模式，下一预约由新的模拟公交接待并重置车厢。此流程仍不是实际固定、系带或发车确认。

本轮验收：dashboard 100 项、Twin 15 项回归测试通过，TypeScript、ESLint 和 Next.js 生产构建通过；两份单文件孪生已同步，约 1.35 MB。真实 `deepseek-flash` single 模式分别验证 STROLLER 和 WHEELCHAIR：前者 15 步含 `PARK_STROLLER`，本次分配 S03；后者 7 步直接到轮椅区。两类各一次模型调用，CV 模拟 HTTP 触发不额外推理，带 token 的 SSE/state 双目标下发通过。未进行实际摄像头或独立手机 App 验收。

浏览器另用真实模型播放一次 STROLLER 预设，确认停车停顿、乘客与推车分离、S03 就座后车厢占用数增加，最终保留推车并等待安全员确认。

近座满后远座回退已用真实 DeepSeek 补验：S02/S03 满时分配 S05，仍下发停车步骤与完整 15 步手机导航；停车后过道直行距离为 1.6 m。可运行 `node scripts/check-journey.mjs --key-stdin --categories STROLLER --stroller-nearby-full`，产生一次付费调用。

浏览器另将近排与中排填满，真实模型分配 S09，完整播放先停车再单独就座的动画，结束后推车仍保留在轮椅区；停车后过道指引为 2.3 m。

复验命令：`cd dashboard && node scripts/check-journey.mjs --key-stdin --categories STROLLER,WHEELCHAIR`，该命令产生两次付费调用；不指定 `--categories` 时仍验证四类、调用四次。各类别使用独立重置的模拟车厢，避免把已经停入推车的轮椅区再次当空位；同车资源不能复用的拒绝分支由回归测试覆盖。

### 9.1 同步 main@353765a 的验证

已保留最新 `RUNBOOK.md`、iOS `app/`、回放桥、上车意图判断、手动 Preview 和下一预约新模拟公交语义，并合入本分支婴儿车停车与座位回退修改。dashboard 108 项、视觉纯逻辑 46 项、Twin 15 项测试通过；ESLint、Twin TypeScript 和 Next.js 生产构建通过，包含 `/passenger-twin` 页面。两份孪生 HTML 从合并后的源码重新构建，约 1.35 MB。

本次同步没有新增付费模型调用，没有重新进行实物摄像头或 iOS 真机/模拟器验收；上文真实 DeepSeek 记录属于同步前的验证。`RUNBOOK.md` 和 `app/` 与指定 main 保持一致，未修改 App UI。
