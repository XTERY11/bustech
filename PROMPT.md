# BusTech 分工下发文档（PROMPT.md）

> **怎么用这份文件**
> 每位成员只需要这一份 md。把它整份交给你自己的 AI 编码助手（Claude Code / Cursor 等），并在开头加一句：
> **「我负责模块 X，请先读第 1–3 节了解全局和契约，再只按第 4 节里模块 X 的内容执行。」**
> 第 2 节的接口契约是全队共同的上层接口，任何人不得单方面修改；要改先看第 5 节。

状态：v0.3（2026-10-01）· 契约负责人：模块 C 负责人（集成负责人）

---

## 1. 系统是什么、现在已经有什么

一个开环演示：乘客带轮椅 / 婴儿车 / 手杖到站 → 系统识别并结合 App 预约 → 大模型（或离线规则）给出决策摘要和动作计划 → 评委在 dashboard 上看到输入信号、思考过程、输出动作，以及公交数字孪生的响应（下蹲、开门、伸出坡道）。车辆状态全程是模拟的，不控制任何真实车辆。

```
 输入流 1（实时视频）                 输入流 2（App 预约）          输入流 3（演示内置预设，兜底）
 camera / 视频文件                     手机 App                      dashboard 上的场景按钮 / demo_signals.py
      │                                   │                                   │
      ▼                                   │                                   │
 [模块 A] vision/ (Python, :8790)         │                                   │
 YOLO + 区域触发                          │                                   │
      │ POST /api/perception              │ POST /api/booking                 │ POST /api/demo
      │ GET  /stream.mjpg（画面）          │                                   │
      ▼                                   ▼                                   ▼
 ┌──────────────── [模块 C] 信号中枢 dashboard/backend (Node, :8787) ──────────────┐
 │ 去重 / 合并快照 → 安全策略 → 决策生成（DeepSeek 或离线规则）→ 动作校验          │
 └───────────────────────────────┬─────────────────────────────────────────────────┘
                                 │ SSE /api/events · GET /api/state
              ┌──────────────────┴───────────────────┐
              ▼                                      ▼
 [模块 C] dashboard 页面 (Next.js, :3000)      [模块 B] App 读取结果，
 输入信号 | 思考→行动 | 输出                   向乘客显示反馈
              │ postMessage twin:telemetry
              ▼
 [模块 D] twin/ 公交数字孪生（iframe, ?embed=1）：公交 + 站台 + 乘客与辅具
```

**已经写好并提交的内容**（提交 `fbb0792`，全链路可用测试视频跑通）：

| 目录 | 内容 | 状态 |
|---|---|---|
| `vision/` | YOLOv8n 权重（4 类：`wheelchair_with` / `wheelchair_without` / `cane` / `stroller`）、区域绘制 `monitor_zone.py`、桥接 `yolo_bridge.py`、测试视频 `demos/clips/` | 可运行；真实摄像头未实测 |
| `dashboard/backend/` | 信号中枢 `hub.mjs` + `server.mjs`、规划器 `planner/`、系统提示词 `prompts/system_prompt.txt`、25 个预设案例 `examples/demo_cases.json` | 可运行，40 项测试 |
| `dashboard/app/` | 页面：摄像头面板、孪生面板、输入信号、Thinking→Action、输出 | 可运行 |
| `twin/` | React Three Fiber 公交模型 + embed 模式，构建为单文件 `dashboard/public/twin/index.html` | 可运行 |
| 手机 App | **尚无代码**。形态定为手机网页 / PWA。参考仓库 `github.com/apinfiniteloop/buspulse-sg`（目前对外不可见，需要仓库所有者开权限） | 待开发 |

三个输出状态的含义（所有模块都要认识）：

| `plan_status` | 含义 | 典型触发 |
|---|---|---|
| `NEEDS_CONFIRMATION` | 需要安全员确认 | 只有摄像头看到辅具、没有 App 预约（感知不能单独授权坡道） |
| `READY` | 可以执行（模拟） | 预约 + 感知一致，车辆条件满足 |
| `CANNOT_EXECUTE` | 不能执行 | 急停、入口受阻等 |

---

## 2. 冻结契约（上层接口，全队共用）

所有地址默认本机；局域网演示时把 `127.0.0.1` 换成集成机 IP，并带 `Authorization: Bearer <BRIDGE_TOKEN>`。

### 2.1 端口

| 端口 | 服务 | 归属 |
|---|---|---|
| 3000 | dashboard 页面 | 模块 C |
| 8787 | 信号中枢 HTTP + SSE | 模块 C |
| 8790 | 视频 MJPEG + health | 模块 A |

### 2.2 输入信封（模块 A、B 共用）

```json
{ "event_id": "<1–80 位，仅 A-Z a-z 0-9 _ . : ->", "observed_at": "<ISO 8601，实际采集时间>", "payload": { } }
```

- 每个新事件用新的 `event_id`；重试必须原样重发（同 ID、同时间、同内容），中枢会去重。
- 同 ID 不同内容 → `409 EVENT_ID_CONFLICT`；同一通道时间倒退 → `400 OUT_OF_ORDER_SIGNAL`；时间超前当前 5 秒以上 → `400 INVALID_OBSERVED_AT`。
- 必须 `Content-Type: application/json`，请求体 ≤ 32 KB。成功返回 `202 {"accepted":true,"duplicate":false,"changed":true|false}`。

### 2.3 感知：`POST /api/perception`（模块 A → 中枢）

```json
{ "event_id": "perception-1042", "observed_at": "2026-10-01T10:00:00Z",
  "payload": { "yolo_detections": [{ "label": "WHEELCHAIR", "confidence": 0.96 }],
               "target_match_confirmed": true,
               "zone": { "triggered": true, "roi_id": "monitor_roi" } } }
```

- `target_match_confirmed`：`true` 表示“经过二次确认的辅具正处在画好的上车区域内”。**中枢只采信带 `true` 的检测**；为 `false` 时检测只会产生一个 `YOLO_TARGET_UNMATCHED` 标记，不影响决策。即使为 `true`，没有预约时结果仍是 `NEEDS_CONFIRMATION`（感知不能单独授权坡道）。

- `label` 取值：`WHEELCHAIR` `CRUTCH` `CANE` `WALKER` `STROLLER` `PERSON` `NONE` `UNKNOWN`。
- `confidence` 0–1；策略阈值 0.75，低于它不算有效识别。检测桥上报的是检测模型与确认模型两者合并后的置信度（noisy-OR：`1-(1-检测)(1-确认)`）。最多 20 条；可选 `track_id`。
- 只发结构化结果，**不发图像**。进入区域发一次，占用期间按心跳（默认 2 秒）重发，离开时发空数组。
- **触发逻辑（占用状态机）**：①进入：有人带着的辅具（或带着它的人）与区域重叠并持续 0.3 秒即触发，上报当时的类别。“与区域重叠”指框的底边中点在区域内，或框下部 30% 与区域的重叠达到框下部或区域面积中较小者的 25%。②占用：触发后只要区域里还有人就保持（人体检测比辅具检测稳定得多），心跳继续上报类别。③离开：区域里连续 2 秒没有任何人才解除，发空数组。
- **识别对象是辅具，不是人**：开放词表模型（YOLO-World）在整幅画面上找出人、带轮辅具和手杖类物件，每台辅具一条轨迹。类别的票记在辅具上（停着时也在累计），所以一台辅具只会有一个框、一个标签。`best.pt` 只认训练时见过的样子，它的框不再使用，只给重叠的辅具投票。**辅具有人带着才算数**：有成年人坐在里面（姿态检测判断，且人不比辅具高出太多），或它被身边的人带离了原来停放的位置（超过自身宽度的 0.3 倍）；一直停着的辅具旁边站多少人都不算，人松手离开约 1 秒后它回到“停放”状态，当前位置成为新的停放位置。类别投票会随时间衰减（只保留最近几秒），被画面边缘切掉一部分的辅具不参与投票。手杖按人逐帧判断（被人握着：贴着人、从手的高度伸到脚边），只看最近约 1 秒，拿起就认、放下就消失。
- **轮椅与婴儿车的区分**：按辅具轨迹累计投票（确认模型的各提示词 + `best.pt` 的类别得分），标签带粘性，只有另一类明显领先才切换；成年人坐在里面直接判为轮椅。

### 2.4 预约：`POST /api/booking`（模块 B → 中枢）

```json
{ "event_id": "app-booking-001", "observed_at": "2026-10-01T10:00:00Z",
  "payload": { "active": true, "intent": "BOARDING",
               "route_id": "DEMO_ROUTE", "stop_id": "DEMO_STOP",
               "accessibility_need": "WHEELCHAIR", "ramp_preference": "REQUESTED",
               "assistance_requested": ["WHEELCHAIR_RAMP", "ADDITIONAL_BOARDING_TIME"],
               "preferred_interaction": "VISUAL", "language": "en-SG" } }
```

| 字段 | 取值 |
|---|---|
| `intent` | `BOARDING` `ALIGHTING` `UNKNOWN` |
| `accessibility_need` | `WHEELCHAIR` `CRUTCH` `CANE` `WALKER` `STROLLER` `VISUAL_ASSISTANCE` `HEARING_ASSISTANCE` `MOBILITY_ASSISTANCE` `NONE` `UNKNOWN` |
| `ramp_preference` | `REQUESTED` `DECLINED` `UNSPECIFIED` |
| `assistance_requested` | `WHEELCHAIR_RAMP` `ADDITIONAL_BOARDING_TIME` `AUDIO_BOARDING_GUIDANCE` `VISUAL_BOARDING_GUIDANCE` `CONFIRM_BUS_IDENTITY`（最多 8 项，不重复） |
| `preferred_interaction` | `AUDIO` `VISUAL` `BOTH` |
| `language` | `zh-CN` `en-SG` |
| `route_id` / `stop_id` | 同 `event_id` 的字符规则 |

取消预约：发一条新事件，`"active": false`。原型只保留**一个**当前预约，预约超过 5 分钟视为过期。

### 2.5 输出：`GET /api/state`（一次性）与 `GET /api/events`（SSE）

SSE 每条为 `data: {"id":n,"type":"…","at":ms,"data":{…}}`，连接后先收到一条 `snapshot`。事件类型：
`snapshot` `signal` `settings` `planning` `summary` `result` `cancelled` `failure`。

快照（`/api/state` 与 `snapshot` 事件的 `data`）：

```ts
type Snapshot = {
  source: 'demo' | 'external';            // 预设 or 真实输入
  mode: 'single' | 'two_turn' | 'rules';  // DeepSeek 单次 / 两轮 / 离线规则
  context: { request?, perception?, vehicle_context? };   // 合并后的输入
  channels: Record<string, { received_at, observed_at, event_id }>;
  running: string | null;                 // 正在规划的 run id
  summary: { request_id, decision_summary: string[] } | null;   // “思考”摘要，1–3 条
  result: Result | null;
};
type Result = {
  request_id: string;
  plan_status: 'READY' | 'NEEDS_CONFIRMATION' | 'CANNOT_EXECUTE';
  simulated: boolean; execution_authorized: boolean;
  decision_summary: string[]; safety_flags: string[];
  action_plan: { step: number; action: string; parameters: object }[];
  passenger_communication: { channel: string; language: string;
                             audio_text: string | null; display_text: string | null };  // 给乘客的反馈
  meta: { mode; source; api_calls; model; latency_ms; error?; validation_passed; usage };
};
```

`action` 只能取这 17 个（`dashboard/backend/planner/contracts.mjs` 的 `ACTIONS`）：
`ABORT_ASSISTANCE_SEQUENCE` `HOLD_AT_STOP` `REQUEST_ONBOARD_SAFETY_OPERATOR` `CHECK_SINGLE_ENTRANCE_CLEARANCE` `KEEP_SINGLE_ENTRANCE_CLEAR` `PREPARE_WHEELCHAIR_AREA` `EXTEND_DWELL_TIME` `KEEP_RAMPS_STOWED` `OPEN_SINGLE_ENTRANCE` `DEPLOY_AUTOMATIC_SHORT_RAMP` `REQUEST_MANUAL_RAMP_DEPLOYMENT` `ACTIVATE_EXTERNAL_SPEAKER` `CONFIRM_ROUTE_IDENTITY` `PLAY_ENTRANCE_AUDIO_BEACON` `SHOW_EXTERNAL_DISPLAY` `WAIT_FOR_BOARDING_CONFIRMATION` `WAIT_FOR_SEATED_AND_BELTED_CONFIRMATION`

### 2.6 控制（dashboard → 中枢）

| 接口 | 请求体 | 作用 |
|---|---|---|
| `POST /api/settings` | `{"mode":"rules"｜"single"｜"two_turn"}` | 切换生成模式 |
| `POST /api/run` | `{}` | 用当前信号重跑 |
| `POST /api/demo` | `{"context":{…},"mode":"rules"}` | 载入预设场景（输入流 3） |
| `GET /api/health` | — | `{ok, llm_configured, model, token_required, simulated_vehicle}`，免 token |

### 2.7 视频（模块 A → 页面）

- `GET http://<vision-host>:8790/stream.mjpg`：multipart JPEG，画面已叠加检测框和绿色区域。
- `GET http://<vision-host>:8790/health`：`{ok, source, device, roi, fps, triggered, inside, detections…}`。

### 2.8 孪生（模块 C 页面 → 模块 D 的 iframe）

- 握手：页面发 `{type:'twin:hello'}`，孪生回 `{type:'twin:ready'}`。
- 驱动：`{type:'twin:telemetry', frame}`，`frame` 字段均可选：

```ts
{ door?: 'closed'|'opening'|'open'|'closing';
  ramp?: 'retracted'|'extending'|'extended'|'retracting';
  kneeling?: boolean;
  boardingStatus?: 'idle'|'request_received'|'preparing'|'ready'|'boarding'|'complete';
  destination?: string;
  announcement?: { active: boolean; text: string };
  passengerInfo?: { title?: string; message?: string } | null;
  // ↓ v0.3 计划新增（可选字段，向后兼容；由模块 D 实现，实现前孪生会忽略它）
  passenger?: { aid: 'wheelchair'|'cane'|'crutch'|'walker'|'stroller'|'visual'|'hearing'|'none';
                stage: 'hidden'|'waiting'|'boarding'|'onboard' } | null }
```

- 动作 → 帧的时间线在 `dashboard/app/lib/twinScenario.ts`。孪生只显示，不回写任何状态。

---

## 3. 全员规则

1. **只改自己模块“可以改”的文件**。跨模块的需求走第 5 节。
2. **全员不得修改**：`vision/monitor_zone.py`、`dashboard/backend/hub.mjs`。`twin/` 下的 3D 组件只有模块 D 可以改。
3. 页面与乘客提示文案保持英文（评委界面）；代码风格跟随所在文件。
4. 密钥（`DEEPSEEK_API_KEY`、`BRIDGE_TOKEN`）只通过环境变量传入，不写进文件、不提交。
5. 每个模块在自己的分支开发：`mod-a-vision`、`mod-b-app`、`mod-c-dashboard`、`mod-d-twin`；合并前必须通过自己模块的验收命令和 `cd dashboard && npm test`（40 项全过）。
6. 环境：Node ≥ 22.13，Python 3.10–3.12。不要全局安装依赖，全部留在 `vision/.venv`、`dashboard/node_modules`、`twin/node_modules`。
7. 遇到失败：贴出原始报错，提出最小修复，不要重构或重写已有代码。

---

## 4. 模块分工

四个模块：两条外部输入流（A、B）可下发给其他成员，核心载体（C）和公交孪生（D）由本队负责。

| 模块 | 一句话 | 评委看到什么 |
|---|---|---|
| A 实时视频输入 | 摄像头 → 识别 → 上报 | dashboard 左上角带检测框和绿色区域的实时画面 |
| B App 输入与乘客反馈 | 手机网页提交预约，并显示系统给乘客的反馈 | 手机上的预约界面和反馈提示 |
| C dashboard 核心载体 | 接收两路输入 → 生成决策 → 展示输入、思考、输出 | 大屏下半部分的三个面板 |
| D 公交孪生嵌入 | 公交、站台、乘客与辅具的 3D 展示，按动作计划做出响应 | 大屏右上角的公交数字孪生 |

A 和 B 只通过第 2 节的 HTTP 接口与 C 通信，D 只通过 2.8 的消息接收 C 的结果；四个模块互相之间没有代码依赖，可以并行开发。

### 模块 A · 实时视频输入

- **目标**：真实摄像头下稳定识别进入上车区域的轮椅 / 婴儿车 / 手杖，按 2.3 上报，并提供 2.7 的画面。
- **可以改**：`vision/yolo_bridge.py`、`vision/aid_verifier.py`、`vision/start_bridge.sh`、`vision/ride_signal_client.py`、`vision/demos/`、ROI 文件。
- **不要改**：`vision/monitor_zone.py`、`dashboard/`、`twin/`。
- **独立开发**（不需要其他模块）：

  ```bash
  cd vision && python3 setup_environment.py
  .venv/bin/python yolo_bridge.py --source demos/clips/wheelchair-003.mp4 --roi monitor_example_roi.json --no-window --no-signal --max-frames 120
  ```

  控制台应出现 `TRIGGER … → CLEAR …` 和 `{"processed_frames":120,…}`。真实摄像头先画区域：`.venv/bin/python monitor_zone.py --source 0`（回车保存 `monitor_roi.json`）。
- **手机摄像头**：手机装 DroidCam 类应用，与电脑连同一网络（如手机热点），视频地址形如 `http://172.20.10.3:4747/video`，直接作为 `--source` 传入：先 `monitor_zone.py --source "<地址>"` 画区域，再 `bash start_demo.sh "<地址>"`。
- **为什么不直接用 `best.pt`**：它的四个类别标注的都是“人 + 辅具”整体，训练集只有一个房间、少数几个人、没有“只有人”的画面，换场地后会把普通行人高置信度地判成婴儿车或轮椅，对没见过的衣着会漏检，轮椅和婴儿车也会混。所以权重没有改，但它在 `yolo_bridge.py` 里只是投票者。实际逻辑见 `aid_verifier.py` 和 2.3 节。确认模型有两个：仓库自带小号（`yolov8s-world-aids.pt`）；超大号效果好得多但约 140 MB 不能入库，需要每台机器本地生成一次：`cd vision && .venv/bin/python aid_verifier.py x`（会下载约 480 MB），生成后自动启用。默认还接受被人握着的雨伞、长杆作为手杖替代物（`--strict-verify` 关闭）；椅子、手推车不再作为轮椅或婴儿车的替代物。`--no-verify` 可退回 `best.pt` 原始输出以对比。注意 `monitor_zone.py` 没有这些逻辑，演示和联调请用 `yolo_bridge.py`。
- **看效果用哪个窗口**：`monitor_zone.py` 只用来画区域，它保存后显示的是没有上述逻辑的原始检测，画完按 `Q` 退出（DroidCam 同时只允许一个连接）。看真实效果用 `BRIDGE_WINDOW=1 bash start_demo.sh "<地址>"` 弹出的检测桥窗口，或 dashboard 左上角。
- **触发记录与回放**：`start_demo.sh` 启动的检测桥会在每次触发、类别变化、解除时把带标注的画面存到 `vision/trigger_snapshots/`（不入库），同目录 `events.jsonl` 记录事件。`record_clip.py` 可以把摄像头原始画面录成 MP4；之后用 `yolo_bridge.py --source <录像> --realtime --no-window --no-signal --snapshots <目录>` 回放，改完逻辑先对着录像验证，不必让人重走一遍。
- **联调**：去掉 `--no-signal`，中枢收到后 `curl http://127.0.0.1:8787/api/state` 的 `context.perception.yolo_detections` 应有对应标签。
- **待办**：二次确认目前只在仓库自带的五段视频上验证过（真辅具全部确认，旁观者零误确认），手机实拍下的效果待测，尤其是手杖和婴儿车；效果不够时的后备方案是加入“只有人”的负样本重训。真实摄像头 / RTSP 实测；现场光照和角度下的置信度（需 ≥ 0.75 才生效）；进出区域的抖动（`--enter-frames` / `--exit-frames`）；Apple Silicon 上 `--device mps` 与 `cpu` 的帧率对比。
- **验收**：`.venv/bin/python -m unittest test_monitor_zone test_aid_verifier` 11 项通过；`curl :8790/health` 返回 `ok:true` 且 `fps > 0`；实物进入区域后 dashboard 出现 `NEEDS_CONFIRMATION`，离开后检测清空。

### 模块 B · App 输入与乘客反馈（手机网页 / PWA）

- **目标**：评委能看到的手机网页：乘客提交预约（2.4），并在同一页面看到系统给自己的反馈（2.5 的 `plan_status` 与 `passenger_communication`）。dashboard 上也会同步显示同一份反馈。
- **代码位置**：独立仓库（参考 `buspulse-sg`）。本仓库内不需要改任何文件。
- **输入**：`POST /api/booking`。**输出**：读取 `GET /api/events`（或每秒轮询 `GET /api/state`），显示 `result.plan_status`、`result.passenger_communication.display_text`；`preferred_interaction` 为 `AUDIO` / `BOTH` 时可用浏览器语音朗读 `audio_text`。
- **界面最少需要**：无障碍需求选择（对应 `accessibility_need`）、是否需要坡道（`ramp_preference`）、提交 / 取消按钮、反馈区（状态 + 提示文字）、连接设置（中枢地址 + token）。
- **独立开发**（只需要 Node，不需要摄像头和模型）：

  ```bash
  cd dashboard && npm ci && npm run bridge          # 只启动中枢 :8787
  curl -X POST http://127.0.0.1:8787/api/settings -H 'Content-Type: application/json' -d '{"mode":"rules"}'
  curl -X POST http://127.0.0.1:8787/api/booking  -H 'Content-Type: application/json' \
    -d '{"event_id":"app-test-1","observed_at":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'","payload":{"active":true,"intent":"BOARDING","route_id":"DEMO_ROUTE","stop_id":"DEMO_STOP","accessibility_need":"WHEELCHAIR","ramp_preference":"REQUESTED","assistance_requested":["WHEELCHAIR_RAMP"],"preferred_interaction":"VISUAL","language":"en-SG"}}'
  curl http://127.0.0.1:8787/api/state
  ```

  没有摄像头时，用 `cd dashboard && python3 integrations/demo_signals.py --scenario wheelchair_auto --mode rules` 模拟感知。
- **网页形态的四个坑**：
  1. **跨域**：浏览器会带 `Origin`，App 的来源（如 `http://192.168.1.20:5173`）必须在中枢的 `ALLOWED_ORIGINS` 里，否则 `403 ORIGIN_NOT_ALLOWED`。本机开发时这样启动中枢：`ALLOWED_ORIGINS=http://localhost:5173 npm run bridge`。联调时把来源地址告诉模块 C（`start_demo.sh` 的局域网模式目前只放行 `:3000`，由模块 C 负责加上 App 来源）。
  2. **混合内容**：中枢是 `http://`。如果 App 部署在 `https://`（如 GitHub Pages），浏览器会拦截对 `http://` 中枢的请求。演示时 App 也用 `http://<局域网 IP>:<端口>` 提供。
  3. **PWA 能力**：Service Worker 和“添加到主屏幕”需要 HTTPS 或 localhost；局域网 `http://` 下只能当普通手机网页用。演示不依赖这些能力。
  4. **带 token 的 SSE**：浏览器原生 `EventSource` 不能带 `Authorization` 头，要用 `fetch` 读流（参考 `dashboard/app/live-client.ts`）或改用轮询。
- **其他**：手机访问需要局域网模式（`LAN=1 bash start_demo.sh`，会打印 IP 和 token），所有请求带 `Authorization: Bearer <token>`。预约超过 5 分钟会过期，演示前重新提交。
- **验收**：手机提交轮椅预约后，dashboard「Mobile app booking」显示该预约；配合感知信号出现 `READY`，手机上显示对应的乘客提示；取消预约（`active:false`）后状态回退。

### 模块 C · dashboard 核心载体（集成负责人）

- **目标**：承接两路输入，生成决策，并把“输入信号 → 大模型思考 → 输出动作 → 乘客反馈”完整展示给评委，再把结果交给模块 D 的孪生。同时负责第 2 节契约、演示内置预设（输入流 3）、`start_demo.sh` 和各模块的合并。
- **文件**：`dashboard/`（除模块 D 的两个文件外）、`start_demo.sh`、本文件。
- **不要改**：`dashboard/backend/hub.mjs`、`twin/`、`dashboard/app/lib/twinScenario.ts`、`dashboard/app/components/TwinPanel.tsx`（后三项属于模块 D）。
- **内部三块**（一个人做，或在模块内再分，互不阻塞）：

| 子块 | 负责什么 | 主要文件 | 评委看到的位置 |
|---|---|---|---|
| C1 信号与契约 | 接收、去重、合并两路输入；对外接口；预设场景 | `backend/server.mjs`、`backend/planner/contracts.mjs`、`backend/examples/demo_cases.json`、`integrations/` | 「Input signals」面板 |
| C2 思考展示 | 决策怎么生成、怎么讲给评委听 | `backend/planner/agent.mjs`、`deepseek.mjs`、`policy.mjs`、`backend/prompts/system_prompt.txt`、`app/live-dashboard.tsx` 的 Thinking 区块 | 「Thinking → Action」面板 |
| C3 输出展示 | 动作计划、乘客提示的呈现 | `app/live-dashboard.tsx` 的输出区块 | 「Actions & passenger guidance」面板 |

- **C2 为什么涉及“决策生成代码和提示词”**：面板上显示的“思考”不是页面自己写的，而是后端每次收到输入后生成的 1–3 条决策摘要。`rules` 模式由本地策略（`policy.mjs`）生成；DeepSeek 模式由大模型按 `system_prompt.txt` 的要求生成，再经同一套策略校验动作，校验失败自动回退到规则结果。所以想改“思考”显示的内容和质量，改的就是这几个文件；只改显示样式则只动页面。
- **独立开发**（不需要摄像头和 App，用页面上的预设场景按钮驱动）：

  ```bash
  cd dashboard && npm ci && npm test                      # 40 项，改策略 / 提示词后必须全过
  npm run dev:integrated                                  # 中枢 + 页面
  DEEPSEEK_API_KEY=... npm run dev:integrated             # 真实模型；key 只放环境变量
  ```

- **待办**：
  - C1：局域网模式下放行 App 来源；确认 App 读取 `/api/events` 的连接数与 token 流程。
  - C2：摘要的可读性（面向评委，短、英文、不泄露内部字段名）；`single` 与 `two_turn` 的延迟与观感取舍；`STROLLER` 标签的提示词覆盖；模型超时 / 出错时的展示。
  - C3：`NEEDS_CONFIRMATION` 与 `CANNOT_EXECUTE` 在输出面板上的区分度；乘客提示与 App 上显示的文字保持一致。
- **验收**：
  - 25 个预设在 `rules` 模式下结果不变，`npm test` 40 项全过。
  - `single` 模式下 `meta.source` 为 “DeepSeek response”、`meta.validation_passed` 为 true；同一输入在三种模式下 `plan_status` 与动作集合一致。

### 模块 D · 公交孪生嵌入 dashboard（本队负责，当前最不完善）

- **目标**：评委在大屏右上角看到一个完整的上车场景：哪一类乘客在站台等候，公交如何为这位乘客做出响应，乘客如何上车。现在只有公交本身。
- **现状**：

| 已有 | 缺口 |
|---|---|
| 程序化建模的公交：车身、车门、坡道、下蹲、目的地屏、状态灯 | 没有任何乘客或辅具模型（轮椅、手杖、拐杖、助行器、婴儿车） |
| HUD：播报条和乘客信息条 | 没有站台环境（路缘、站牌、与摄像头绿色区域对应的上车区） |
| iframe 嵌入 + `twin:telemetry` 驱动 | 帧里没有“乘客是哪一类”的字段，孪生不知道该显示什么 |
| 时间线：准备 → 下蹲 → 开门 → 伸坡道 → Ready to board | 时间线停在 `ready`；`boarding` / `complete`、收坡道、关门、复位都没有触发 |
| 三个相机预设 `overview` / `entrance` / `ramp` | 嵌入模式下不会随阶段自动切换视角 |

- **可以改**：`twin/` 全部、`dashboard/app/lib/twinScenario.ts`、`dashboard/app/components/TwinPanel.tsx`。
- **不要改**：后端、`dashboard/app/live-dashboard.tsx`（需要新数据时找模块 C）。
- **输入**：2.5 的 `Result` + `context`（由 `TwinPanel` 传入）。**输出**：2.8 的 telemetry 帧。孪生只显示经过校验的动作计划，不自行判断该不该放坡道，也不回写任何状态。

**怎么做（建议方案）**

1. **场景分三层**，各自独立成组件，互不影响：
   - 公交（已有，`twin/src/components/BusDigitalTwin/`，尽量少动）；
   - 站台环境（新增 `twin/src/components/Stop/`：路缘、站牌、地面上的绿色上车区）；
   - 乘客与辅具（新增 `twin/src/components/Passengers/`）。
2. **辅具模型库**：每种辅具一个组件，统一接口 `<Passenger aid stage />`。沿用公交的做法，用基础几何体程序化建模、同一套材质，不引入外部模型文件。原因是孪生要构建成单个 `index.html`（现在 1.3 MB），外部 GLB 必须内联进去，体积和加载都会变差。如果确实要用 GLB，要求能被 `npm run build:single` 内联，且 `index.html` 控制在 3 MB 以内。

| `aid` | 模型 | 来源信号 |
|---|---|---|
| `wheelchair` | 坐姿人形 + 轮椅 | 预约 `WHEELCHAIR`；感知 `WHEELCHAIR` |
| `cane` | 站姿人形 + 手杖 | `CANE` |
| `crutch` | 站姿人形 + 双拐 | `CRUTCH` |
| `walker` | 站姿人形 + 助行器 | `WALKER` |
| `stroller` | 站姿人形 + 婴儿车 | `STROLLER` |
| `visual` | 站姿人形 + 白手杖 + 图标 | 预约 `VISUAL_ASSISTANCE` |
| `hearing` | 站姿人形 + 图标 | 预约 `HEARING_ASSISTANCE` |
| `none` | 不显示 | 无预约且无识别 |

3. **辅具类型怎么定**（写在 `twinScenario.ts`）：优先用预约的 `context.request.accessibility_need`；没有预约时用感知里置信度最高且 ≥ 0.75 的标签；都没有则 `none`。
4. **契约扩展**：按 2.8 新增可选字段 `passenger: { aid, stage }`。需要同步改三处：`twin/src/types/vehicle.ts`（状态）、`twin/src/adapters/telemetryAdapter.ts` 的 `normalizeTelemetry`（解析）、`twinScenario.ts` 的 `TwinFrame`（发送）。
5. **时间线补全**（`twinScenario.ts`）：

| 阶段 | 乘客 `stage` | 公交 |
|---|---|---|
| 识别到或有预约，结果未出 / `NEEDS_CONFIRMATION` | `waiting`（站在上车区） | 不动，显示安全员提示 |
| `READY` | `waiting` | 现有序列：下蹲 → 开门 → 伸坡道（是否伸坡道只看动作计划） |
| Ready to board 之后 | `boarding`（沿坡道或车门移动进车） | `boardingStatus: boarding` |
| 进入车内 | `onboard` | 收坡道 → 关门 → 复位 → `complete` |
| `CANNOT_EXECUTE` | `waiting` | 复位，显示暂停提示 |

   上车阶段由谁触发需要定一下：系统是开环的，没有“乘客已上车”的真实信号。建议第一版在 Ready to board 后停留几秒自动播放上车和收尾；第二版再考虑在 dashboard 上加一个 “Confirm boarded” 按钮（需要模块 C 配合）。
6. **各类乘客的画面差异**都来自动作计划，孪生不写死：轮椅且请求坡道 → 下蹲 + 坡道；婴儿车 → 坡道保持收起、显示延长停靠时间；视觉协助 → 播报条；听觉协助 → 信息条。
7. **嵌入体验**：阶段变化时自动切换相机预设（等候 `overview`，开门 `entrance`，伸坡道和上车 `ramp`）；iframe 尺寸变化时画面自适应；新结果到来时乘客和公交一起复位。

- **独立开发**（不需要摄像头、App、模型）：

  ```bash
  cd twin && npm ci && npm run dev                        # 单独调孪生，自带 DemoControls 面板
  bash twin/sync_to_dashboard.sh                          # 每次改完 twin 后构建到 dashboard/public/twin/index.html
  cd dashboard && npm run dev:integrated                  # 用页面预设场景按钮驱动，观察嵌入效果
  ```

- **里程碑**：
  - M1：`passenger` 字段打通 + 轮椅模型 + `waiting` 显示（预设 `wheelchair_auto` 能看到轮椅乘客在站台）。
  - M2：婴儿车、手杖、拐杖模型 + 上车与收尾动画 + 相机自动切换。
  - M3：站台环境、助行器、视觉 / 听觉图标、细节打磨。
- **验收**：
  - `wheelchair_auto` 预设 → 站台出现轮椅乘客，公交依次下蹲、开门、伸出坡道，乘客沿坡道上车，随后收坡道、关门，状态到 `complete`。
  - `stroller` 预设 → 出现婴儿车，坡道保持收起；`crutch` 预设 → 出现拐杖乘客；`emergency_stop` 预设 → 复位并显示暂停提示。
  - 只有感知没有预约（`yolo_only` 预设）→ 显示对应乘客在等候，公交不动。
  - `cd twin && npm run typecheck` 通过；`dashboard/public/twin/index.html` ≤ 3 MB；旧帧（不带 `passenger`）仍能正常驱动。

---

## 5. 契约变更流程

1. 提出方写清楚：改哪个字段 / 接口、为什么、影响哪些模块。
2. 模块 C 负责人确认后先更新本文件第 2 节和 `dashboard/backend/planner/contracts.mjs`，版本号 +0.1，再通知全员。
3. 受影响模块各自适配；未更新本文件的接口改动一律不合并。

向后兼容的新增（可选字段、新预设案例）可以直接提；删除或改名字段、改枚举值、改端口都属于破坏性变更。

---

## 6. 联调与演示顺序

```bash
bash start_demo.sh              # 测试视频 + 离线规则，无需摄像头和 key
bash start_demo.sh 0            # 真实摄像头（先画 vision/monitor_roi.json）
LAN=1 bash start_demo.sh 0      # 手机 App 和其他电脑接入，打印 IP 与 token
```

演示脚本：
1. 实物进入绿色区域 → 模块 A 上报 → `NEEDS_CONFIRMATION`，孪生显示安全员提示。
2. 手机网页提交预约 → 模块 B 上报 → `READY` → 孪生下蹲、开门、伸坡道；手机和 dashboard 同时显示乘客提示。
3. 切换到 “DeepSeek · Single call” → 思考面板显示模型生成的摘要；孪生动画不变（动作由同一策略校验）。
4. 任一输入现场失效时，用页面预设场景按钮（输入流 3）兜底。

---

## 7. 尚未确定（由集成负责人补充）

- [ ] 各模块负责人姓名与联系方式
- [ ] 模块 D：上车阶段的触发方式（自动播放 / dashboard 按钮）；第一版要做哪几种辅具
- [ ] `buspulse-sg` 仓库访问权限（拿到后补充模块 B 与现有代码的对接说明）
- [ ] App 是否需要中文界面（契约已支持 `language: zh-CN`，但当前乘客提示文案只有英文）
- [ ] 截止日期与第一次联调时间
