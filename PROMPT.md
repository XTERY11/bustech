# BusTech 分工下发文档（PROMPT.md）

> **怎么用这份文件**
> 每位成员只需要这一份 md。把它整份交给你自己的 AI 编码助手（Claude Code / Cursor 等），并在开头加一句：
> **「我负责模块 X，请先读第 1–3 节了解全局和契约，再只按第 4 节里模块 X 的内容执行。」**
> 第 2 节的接口契约是全队共同的上层接口，任何人不得单方面修改；要改先看第 5 节。

状态：v0.6（2026-10-03）· 契约负责人：模块 C 负责人（集成负责人）

---

## 0. v0.4 / v0.5 / v0.6 补充

本分支已同步 `main@353765a`。最新视觉 `zone.boarding/dwell_seconds`、手动 Preview、回放模式、iOS App 和 `RUNBOOK.md` 均保留。完成旅程后的下一预约对应新的模拟公交，重置车厢；尚未完成的当前公交仍保留占用。以下 v0.6 补充继续定义婴儿车分离和近座优先行为。

### v0.6 婴儿车停车与附近就座补充

`STROLLER` 的乘客和推车有两个不同目标：`Result.boarding_target` 仍为乘客的 `SEAT`，优先轮椅区附近的第一排 `S02/S03`；两座都满时依次选择下一层低地板靠过道空座 `S05/S06`、`S08/S09`，上一层无空座才进入下一层。新增可选 `Result.equipment_target` 为 `{type:'WHEELCHAIR_BAY',id:'WHEELCHAIR_BAY'}`，表示推车停车目标。轮椅区或折叠座 F01 已占用、六个支持座位都满时必须 `NEEDS_CONFIRMATION`；不使用靠窗穿座路线或后排台阶路线。`WHEELCHAIR` 保持人椅一体，`boarding_target` 为轮椅区，`equipment_target` 为 null。其他类别的 `equipment_target` 为 null。

`cabin_navigation`、`journey`、`journey.animation` 和 `Snapshot.navigation` 同步新增可选 `equipment_target`。STROLLER 的路线先推车到轮椅区，再由乘客走向实际分配空座；`navigation_steps` 新增 `PARK_STROLLER` maneuver，文字提示遵从安全员停车指导，距离为 null。较远座位的停车后行走距离按对应几何计算，不复用 S03 的距离。App 应展示该步骤的 `text`，不把最终座位编号理解成推车目标。旧 App 输入接口和动作枚举不变，手机 UI 仍由独立项目适配。

孪生 `passengerJourney` 新增可选 `equipmentDestination`，值同设备停车目标。旧帧不带该字段仍可解析；新 STROLLER 帧从入口推车到轮椅区，在停车点分离，推车保留在轮椅区，乘客沿过道到实际分配座位，直到安全员确认阶段。STROLLER 上车展示总时长 22000 ms，其它类别仍为 16000 ms。停车时乘客脚点约 `x=-1.55,z=0.08`，推车中心约 `x=-1.55,z=-0.54`；这些只属于模拟地图。完成的模拟旅程同时占用轮椅区和分配座位，不能再把该区分给另一位轮椅或推车乘客。

### v0.5 车内导航补充（保留；婴儿车以 v0.6 为准）

手机 App 源码已随最新 main 纳入 `app/`；本次 dashboard 集成只下发导航数据，不改 App UI。LLM 在生成已校验动作和座位目标的同一次响应中生成 `navigation_steps` 英文指引，不另外发起一次推理。服务端先按模拟车厢布局计算从单入口内侧、面朝车内开始的路线；模型不得更换目标、左右转顺序或距离。距离是模型几何的近似水平米数，不是真实定位测量。

`Result.cabin_navigation` 新增为 `null` 或 `{layout_id,origin:{type:'ENTRANCE',id:'SINGLE_ENTRANCE',facing:'INTO_BUS'},target,steps,mode:'map_based',simulated:true,requires_operator:true}`。每个 step 为 `{step:number,maneuver:'START'|'STRAIGHT'|'TURN_LEFT'|'TURN_RIGHT'|'ARRIVE',distance_m:number|null,text:string}`；非直行步骤的距离为 null。方向相对于乘客当前面向，不是地图北向；首步明确入口和朝向，末步要求安全员确认，不声明已固定或可发车。

上车阶段的 `Snapshot.navigation.steps` 携带这份路线，`instruction` 为步骤文字；`cabin_route` 携带原始车内导航对象，供 App 提前获知路径。预约/等候阶段的 steps 为空，不提示乘客提前往车内走。仍通过既有 `navigation` SSE 和 `/api/state` 下发。没有乘客实时坐标或逐步完成回执，因此不声称实时转弯纠偏，也不按播放时间自动确认真实乘客已走到某一步。

### v0.4 联调补充（保留；车内导航以 v0.5/v0.6 为准，旧客户端可忽略新增字段）

- 手机导航：`Snapshot.navigation` 为 `null` 或 `{id, revision, phase, destination, instruction, simulated:true, animation}`。`phase` 为 `TO_STOP / WAIT_AT_STOP / BOARD_BUS / TO_SEAT / TO_WHEELCHAIR_BAY`，`destination` 为 `{type:'BUS_STOP'|'SEAT'|'WHEELCHAIR_BAY',id}`；只提供已知站点 ID 和文字指引，不伪造 GPS 路线。LLM 生成并通过校验后立即推送，不必等下一条 CV 心跳。SSE 新增 `navigation`，data 为 `{navigation,snapshot}`；`result` 的 data 新增 `snapshot`。旧客户端可继续读 `snapshot` 或轮询 `/api/state`。取消/过期时导航为 null。
- 手机端为独立项目，本仓库不实现手机 UI。中枢只按 HTTP/SSE 契约下发 navigation、journey.guidance 和 animation 时钟，手机端自行呈现；dashboard 同步展示这份数据。

- 保留 `/api/booking`、`/api/perception`、`/api/state`、`/api/events` 和原输入信封。CV 的 `enter/present/exit` 仍是观察事实；`exit` 只表示已经离开 ROI，不表示已坐好或已固定轮椅。暂不新增“即将离开”事件。
- 每条新预约的 `event_id` 成为中枢生成的 `journey.journey_id`，重试不得生成新 ID。中枢向 planner 注入只读 `booking_event_id`，App 无需增加请求字段。
- 模拟 `vehicle_context.cabin` 可包含 `{layout_id:'byd-b70a02-photo-v1', occupied_seat_ids:string[], wheelchair_bay_occupied:boolean}`。座位由可信策略根据空位及预约 ID 稳定分配；轮椅只分配轮椅区，普通乘客请求坡道不改变其座位类别。
- Result 新增 `boarding_target: null | {type:'SEAT',id:'S01'…'S16'} | {type:'WHEELCHAIR_BAY',id:'WHEELCHAIR_BAY'}`。新增动作 `GUIDE_PASSENGER_TO_ASSIGNED_PLACE`，其服务端参数为 `{target_type,target_id}`，位于等待上车与等待就座确认之间。LLM 必须原样返回策略指定的目标。
- `journey` 保留 `stage/need/labels/matched/seat/guidance`，新增 `journey_id/revision/completed/pending_exit/boarding_target` 及 `animation`。`animation` 为 `null` 或 `{id,phase:'arrival'|'boarding',aid,started_at,duration_ms,target}`；时间为中枢 epoch ms。App 与 dashboard 使用同一份指引、目标和动画描述，心跳不重播动画。
- CV 进入握手要求 `target_match_confirmed=true`、置信度 ≥0.75、类别符合当前有效预约。信号 1启动模拟公交进站（4200 ms）与车辆准备，总时长10000 ms；不匹配时车保持不动。信号 2必须是明确 `exit` 且 `left` 匹配此次到站类别；规划或准备尚未完成时保留待处理退出。
- 中枢每次旅程转换、规划完成和预约取消/过期均广播完整 `snapshot`。首次预约可调用 LLM，CV 心跳及两次触发不重复调用 LLM；必要的安全复验只使用规则。
- `ON_BOARD` 是开环上车展示：保持已分配位置，当前预约不再被后续 CV 输入复用。占用只更新模拟客舱；不能据动画完成宣称真实坐好、轮椅固定完成或允许发车。
- Twin 新增可选 `arrival:{id:string,progress:number}|null` 及 `passengerJourney:{journeyId,aid,stage,destination,progress}|null` 帧字段。旧帧可省略；null 清除，进度范围0–1。车辆进站和乘客运动都是展示动画。


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
| `dashboard/backend/` | 信号中枢 `hub.mjs` + `server.mjs`、规划器 `planner/`、系统提示词 `prompts/system_prompt.txt`、25 个预设案例 `examples/demo_cases.json` | 可运行，46 项测试 |
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
               "zone": { "triggered": true, "roi_id": "monitor_roi", "event": "enter" } } }
```

- `zone.event`：站台区域发生了什么。`enter`（进入时发一次）、`present`（占用期间的心跳）、`exit`（区域空了，此时 `yolo_detections` 为空，`zone.left` 列出刚才在场的辅具类别）。`enter` 驱动决策和给乘客的反馈；`exit` 只说明目标离开监控区，**不能证明已上车**。
- `exit` 另带两个字段：`zone.dwell_seconds`（区域被占用了多久）和 `zone.boarding`（检测桥对“是否朝车走去”的判断）。`boarding: true`：在区域里至少停了 2 秒（`--min-dwell`），然后最后一次看到辅具时它已越过区域朝车一侧的边，或离开时仍在朝那个方向移动；`false`：停留太短（路过），或从侧面 / 朝镜头方向离开；字段缺失：辅具没跟上，按上车处理。车在哪个方向由 ROI 文件的 `board_direction` 或 `--board-direction` 指定，默认 `up`（往画面深处）。中枢只在 `boarding !== false` 时把离开当作上车（`ON_BOARD`），否则回到 `BOOKED`。
- `target_match_confirmed`：`true` 表示“经过二次确认的辅具正处在画好的上车区域内”。**中枢只采信带 `true` 的检测**；为 `false` 时检测只会产生一个 `YOLO_TARGET_UNMATCHED` 标记，不影响决策。即使为 `true`，没有预约时结果仍是 `NEEDS_CONFIRMATION`（感知不能单独授权坡道）。

- `label` 取值：`WHEELCHAIR` `CRUTCH` `CANE` `WALKER` `STROLLER` `PERSON` `NONE` `UNKNOWN`。
- `confidence` 0–1。带 `target_match_confirmed: true` 的目标已由检测桥按自己的规则确认，中枢只核对类别，不再按 0.75 复审；0.75 只用于未确认的原始检测。检测桥上报的是检测模型与确认模型两者合并后的置信度（noisy-OR：`1-(1-检测)(1-确认)`）。最多 20 条；可选 `track_id`。
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

模拟车辆上下文可带可选座舱快照：

```json
"cabin": {
  "layout_id": "byd-b70a02-photo-v1",
  "occupied_seat_ids": ["S01", "S04", "S06", "S08", "S10", "S13", "S15"],
  "wheelchair_bay_occupied": false
}
```

`occupied_seat_ids` 只允许 `S01`–`S16` 和 `F01`，不得重复。缺少 `cabin` 表示座位状态未知，不得当作空车；`F01` 是轮椅区折叠座，不分配给上车乘客。

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
  boarding_target: { type: 'SEAT' | 'WHEELCHAIR_BAY'; id: string } | null;
  decision_summary: string[]; safety_flags: string[];
  action_plan: { step: number; action: string; parameters: object }[];
  passenger_communication: { channel: string; language: string;
                             audio_text: string | null; display_text: string | null };  // 给乘客的反馈
  meta: { mode; source; api_calls; model; latency_ms; error?; validation_passed; usage };
};
```

`action` 只能取这 18 个（`dashboard/backend/planner/contracts.mjs` 的 `ACTIONS`）：
`ABORT_ASSISTANCE_SEQUENCE` `HOLD_AT_STOP` `REQUEST_ONBOARD_SAFETY_OPERATOR` `CHECK_SINGLE_ENTRANCE_CLEARANCE` `KEEP_SINGLE_ENTRANCE_CLEAR` `PREPARE_WHEELCHAIR_AREA` `EXTEND_DWELL_TIME` `KEEP_RAMPS_STOWED` `OPEN_SINGLE_ENTRANCE` `DEPLOY_AUTOMATIC_SHORT_RAMP` `REQUEST_MANUAL_RAMP_DEPLOYMENT` `ACTIVATE_EXTERNAL_SPEAKER` `CONFIRM_ROUTE_IDENTITY` `PLAY_ENTRANCE_AUDIO_BEACON` `SHOW_EXTERNAL_DISPLAY` `WAIT_FOR_BOARDING_CONFIRMATION` `GUIDE_PASSENGER_TO_ASSIGNED_PLACE` `WAIT_FOR_SEATED_AND_BELTED_CONFIRMATION`

`boarding_target` 由可信规则根据座舱快照选择，DeepSeek 只能原样返回。普通乘客只会分配到已知空座；轮椅乘客使用 `WHEELCHAIR_BAY`。`GUIDE_PASSENGER_TO_ASSIGNED_PLACE` 的参数包含相同目标，座位状态未知或计划未就绪时目标为 `null`。

### 2.5b 乘客旅程：给 App 和 dashboard 共用的阶段（`snapshot.journey`）

`GET /api/state` 和每个 `signal` / `snapshot` 事件里的快照都带 `journey`（预设场景时为 `null`）。App 不需要自己推断流程，只要按 `stage` 切换画面，并显示或朗读 `guidance`。

```ts
journey: {
  stage: 'IDLE' | 'BOOKED' | 'AT_STOP' | 'ON_BOARD';
  matched: boolean;        // 到站的辅具类别与预约的需求是否一致（系统内部的“握手”，乘客不用操作）
  need: string | null;     // 预约的 accessibility_need
  labels: string[];        // 摄像头在站台区域看到的辅具类别
  seat: string | null;     // 上车后分配的位置：'WHEELCHAIR_BAY' 或优先座编号（如 'S02'）
  guidance: { title: string; display_text: string; audio_text: string };  // 这一阶段该告诉乘客什么
}
```

| `stage` | 进入条件 | 大模型 | 公交孪生 | 给乘客的指引（`guidance`） |
|---|---|---|---|---|
| `IDLE` | 没有有效预约 | — | 待命 | 提示先预约 |
| `BOOKED` | App 发来预约（`POST /api/booking`） | **在这里推理一次**，方案此时就定好 | 显示“已收到请求”，车不动、不放坡道 | 已收到预约，请前往站台上车点 |
| `AT_STOP` | 摄像头看到带辅具的人进入站台区域（`zone.triggered`） | 不再调用；本地规则核对方案是否仍成立，成立就立即执行 | `matched` 且 `READY`：下蹲、开门、按方案伸坡道；不一致：车继续等待，不开门 | `READY` 时为上车指引；类别不一致或无预约时请等待安全员 |
| `ON_BOARD` | `READY` 且 `matched` 的乘客离开站台区域（`zone.event = exit`） | — | 上车 → 剖面视角显示座位或轮椅位 → 收坡道 → 关门 → 完成 | 车内指引：轮椅位，或分配的优先座 |

- 上车后这次预约即用完：`need` 变为 `null`，`ON_BOARD` 一直保持到下一次预约，期间其他人进出站台不会打断它。

- 没有可见辅具的需求（如听障）无法由摄像头确认类别，站台上出现任何辅具都算一致；这类乘客目前没有“到站”的视觉信号，是已知缺口。
- 到站前方案已经是 `READY`，这表示“方案已备好”，是否执行由 `stage` 决定。
- 逻辑在 `dashboard/backend/journey.mjs`，测试在 `dashboard/tests/journey.test.mjs`。

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
  seatOccupancy?: Record<string, boolean>;
  passengerJourney?: {
    journeyId: string;
    aid: 'wheelchair'|'cane'|'crutch'|'walker'|'stroller'|'visual'|'hearing'|'none';
    stage: 'hidden'|'boarding'|'navigating'|'seated'|'secured';
    destination: { type: 'SEAT'|'WHEELCHAIR_BAY'; id: string };
    progress?: number;
  } | null }
```

- `seatOccupancy` 使用稳定座位号（见 `twin/src/data/cabinLayout.ts`）；`passengerJourney: null` 清除当前移动乘客，缺少该字段则保持旧状态。`SEAT` 目标只接受 `S01`–`S16`，轮椅区目标必须为 `WHEELCHAIR_BAY`。
- 切换视角：`{type:'twin:camera', preset}`，`preset` 为 `overview` / `entrance` / `ramp` / `cutaway` / `interior`。
- 时间线在 `dashboard/app/lib/twinScenario.ts`，分两半：`actionsToScenario` 是到站（下蹲、开门、伸坡道、Ready to board）；`boardingScenario` 是演示上车（从车门进入 → 沿高亮路径前往经校验的空座/轮椅区 → 显示到位）。它只由页面的 **Preview boarding** 显式触发。到位后保持车门/坡道的已验证状态并等待安全员确认，不自行宣称完成、关门或发车。孪生只显示，不回写任何状态。

---

## 3. 全员规则

1. **只改自己模块“可以改”的文件**。跨模块的需求走第 5 节。
2. **全员不得修改**：`vision/monitor_zone.py`。`dashboard/backend/hub.mjs` 只由模块 C 负责人改，改动必须带测试。`twin/` 下的 3D 组件只有模块 D 可以改。
3. 页面与乘客提示文案保持英文（评委界面）；代码风格跟随所在文件。
4. 密钥（`DEEPSEEK_API_KEY`、`BRIDGE_TOKEN`）只通过环境变量传入，不写进文件、不提交。
5. 每个模块在自己的分支开发：`mod-a-vision`、`mod-b-app`、`mod-c-dashboard`、`mod-d-twin`；合并前必须通过自己模块的验收命令和 `cd dashboard && npm test`（46 项全过）。
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
  .venv/bin/python yolo_bridge.py --source demos/clips/wheelchair_2.mp4 --roi monitor_example_roi.json --no-window --no-signal --max-frames 120
  ```

  控制台应出现 `TRIGGER … → CLEAR …` 和 `{"processed_frames":120,…}`。真实摄像头先画区域：`.venv/bin/python monitor_zone.py --source 0`（回车保存 `monitor_roi.json`）。
- **手机摄像头**：手机装 DroidCam 类应用，与电脑连同一网络（如手机热点），视频地址形如 `http://172.20.10.3:4747/video`，直接作为 `--source` 传入：先 `monitor_zone.py --source "<地址>"` 画区域，再 `bash start_demo.sh "<地址>"`。
- **为什么不直接用 `best.pt`**：它的四个类别标注的都是“人 + 辅具”整体，训练集只有一个房间、少数几个人、没有“只有人”的画面，换场地后会把普通行人高置信度地判成婴儿车或轮椅，对没见过的衣着会漏检，轮椅和婴儿车也会混。所以权重没有改，但它在 `yolo_bridge.py` 里只是投票者。实际逻辑见 `aid_verifier.py` 和 2.3 节。确认模型有两个：仓库自带小号（`yolov8s-world-aids.pt`）；超大号效果好得多但约 140 MB 不能入库，需要每台机器本地生成一次：`cd vision && .venv/bin/python aid_verifier.py x`（会下载约 480 MB），生成后自动启用。默认还接受被人握着的雨伞、长杆作为手杖替代物（`--strict-verify` 关闭）；椅子、手推车不再作为轮椅或婴儿车的替代物。`--no-verify` 可退回 `best.pt` 原始输出以对比。注意 `monitor_zone.py` 没有这些逻辑，演示和联调请用 `yolo_bridge.py`。
- **看效果用哪个窗口**：`monitor_zone.py` 只用来画区域，它保存后显示的是没有上述逻辑的原始检测，画完按 `Q` 退出（DroidCam 同时只允许一个连接）。看真实效果用 `BRIDGE_WINDOW=1 bash start_demo.sh "<地址>"` 弹出的检测桥窗口，或 dashboard 左上角。
- **触发记录与回放**：`start_demo.sh` 启动的检测桥会在每次触发、类别变化、解除时把带标注的画面存到 `vision/trigger_snapshots/`（不入库），同目录 `events.jsonl` 记录事件。`record_clip.py` 可以把摄像头原始画面录成 MP4；之后用 `yolo_bridge.py --source <录像> --realtime --no-window --no-signal --snapshots <目录>` 回放，改完逻辑先对着录像验证，不必让人重走一遍。
- **同接口的模拟视觉（给其他模块联调用）**：`yolo_bridge.py --capture <目录>` 在真实运行时额外保存 `annotated.mp4`（带框的画面）和 `signals.jsonl`（每条发给中枢的信号及其在视频中的秒数）；`replay_bridge.py --capture <目录>` 不需要摄像头、torch 和权重，按原来的时间重放画面和信号，端口与接口（2.3、2.7）和检测桥完全相同。`bash start_demo.sh demos/captures/venue` 直接用仓库自带的现场采集启动，每遍在收到预约后开始播放。改了 2.3 的信号格式，要重新做一次采集。
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
  cd dashboard && npm ci && npm test                      # 46 项，改策略 / 提示词后必须全过
  npm run dev:integrated                                  # 中枢 + 页面
  DEEPSEEK_API_KEY=... npm run dev:integrated             # 真实模型；key 只放环境变量
  ```

- **待办**：
  - C1：局域网模式下放行 App 来源；确认 App 读取 `/api/events` 的连接数与 token 流程。
  - C2：摘要的可读性（面向评委，短、英文、不泄露内部字段名）；`single` 与 `two_turn` 的延迟与观感取舍；`STROLLER` 标签的提示词覆盖；模型超时 / 出错时的展示。
  - C3：`NEEDS_CONFIRMATION` 与 `CANNOT_EXECUTE` 在输出面板上的区分度；乘客提示与 App 上显示的文字保持一致。
- **验收**：
  - 25 个预设在 `rules` 模式下结果不变，`npm test` 46 项全过。
  - `single` 模式下 `meta.source` 为 “DeepSeek response”、`meta.validation_passed` 为 true；同一输入在三种模式下 `plan_status` 与动作集合一致。

### 模块 D · 公交孪生嵌入 dashboard（本队负责，当前最不完善）

- **目标**：评委在大屏右上角看到一个完整的上车场景：哪一类乘客在站台等候，公交如何为这位乘客做出响应，以及乘客如何被引导到经校验的空座或轮椅区。
- **现状**：

| 已有 | 缺口 |
|---|---|
| 程序化公交、车门、坡道、下蹲、客舱、16 个固定座和 F01 折叠座 | 尚无真实车载座位传感器；座位状态是演示快照 |
| 已占座乘客、移动乘客及轮椅/手杖/拐杖/助行器/婴儿车模型 | 暂只演示一名新乘客，孪生状态不回写中枢 |
| iframe + `twin:telemetry`，支持 `seatOccupancy` / `passengerJourney` | 没有站台环境（路缘、站牌、与摄像头绿色区域对应的上车区） |
| 到站动作 + 上车、走道导航、入座/到轮椅区动画 | “已坐稳/已固定”仍需安全员真实确认，本原型不会授权离站 |
| `overview` / `entrance` / `ramp` / `cutaway` / `interior` 视角自动切换 | 多乘客调度和持久化座位更新尚未实现 |

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
4. **契约扩展**：按 2.8 使用可选字段 `passengerJourney`。实现同步位于 `twin/src/types/vehicle.ts`（状态）、`twin/src/adapters/telemetryAdapter.ts`（解析）和 `twinScenario.ts`（发送）；旧帧不带该字段时仍兼容。
5. **时间线补全**（`twinScenario.ts`）：

| 阶段 | 乘客 `stage` | 公交 |
|---|---|---|
| 结果未出 / `NEEDS_CONFIRMATION` | 无旅程或 `hidden` | 不动，显示安全员提示 |
| `READY` | 尚未开始旅程 | 下蹲 → 开门 → 伸坡道（是否伸坡道只看动作计划） |
| Preview boarding | `boarding` → `navigating` | 保持入口开放，切到入口与剖面视角 |
| 到达目标 | `seated`（座位）或轮椅留在 bay | 更新展示用座位占用，等待安全员确认 |
| `CANNOT_EXECUTE` | 清除旅程 | 复位并显示暂停提示 |

   系统是开环的，没有“乘客已上车”的真实确认。dashboard 的 **Preview boarding** 只驱动画面，不会写回中枢或替代安全员确认；`zone.event = exit` 仅保留为感知观察数据。
6. **各类乘客的画面差异**都来自动作计划，孪生不写死：轮椅且请求坡道 → 下蹲 + 坡道；婴儿车 → 坡道保持收起、显示延长停靠时间；视觉协助 → 播报条；听觉协助 → 信息条。
7. **嵌入体验**：阶段变化时自动切换相机预设（等候 `overview`，开门 `entrance`，伸坡道和上车 `ramp`）；iframe 尺寸变化时画面自适应；新结果到来时乘客和公交一起复位。

- **独立开发**（不需要摄像头、App、模型）：

  ```bash
  cd twin && npm ci && npm run dev                        # 单独调孪生，自带 DemoControls 面板
  bash twin/sync_to_dashboard.sh                          # 每次改完 twin 后构建到 dashboard/public/twin/index.html
  cd dashboard && npm run dev:integrated                  # 用页面预设场景按钮驱动，观察嵌入效果
  ```

- **里程碑**：
  - M1（完成）：座舱快照 + `boarding_target` + 经校验的空座/轮椅区分配。
  - M2（完成）：`passengerJourney` + 多种辅具模型 + 上车、走道导航、入座动画和相机切换。
  - M3（待做）：站台环境、多乘客调度、真实安全员确认与座位状态回写。
- **验收**：
  - `wheelchair_auto` 预设 → `boarding_target=WHEELCHAIR_BAY`；公交下蹲、开门、伸坡道；Preview 后轮椅沿路径进入 bay，并停在安全员确认状态。
  - `crutch` 预设 → 分配当前空的最近优先座（baseline 为 `S03`），乘客沿走道到该座并显示落座；已占座绝不被分配。
  - 满座 / 轮椅区占用 → `NEEDS_CONFIRMATION` 且 `boarding_target=null`；`emergency_stop` → 复位并显示暂停提示。
  - 只有感知没有预约（`yolo_only`）→ 公交不动；旧帧（不带 `passengerJourney`）仍可驱动车门和坡道。
  - `cd twin && npm test && npm run typecheck` 通过；`dashboard/public/twin/index.html` ≤ 3 MB。

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
