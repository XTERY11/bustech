# App 侧交接文档（HANDOFF-APP.md）

状态：2026-10-03 · 面向 App 负责人和所有要改 App 的同学 · 总体说明见 [HANDOFF.md](HANDOFF.md)，接口定义见 [PROMPT.md](PROMPT.md)

这份文档回答五个问题：我们要 App 做什么、现在做到了哪一步、你需要做什么、App 怎样和其余部分衔接、演示怎样启动。最后一节列出以后做小修改时该改哪个文件。

---

## 1. 需求

乘客在手机上选一个辅助类别（轮椅、婴儿车、手杖等）并提交预约，之后不需要再操作，手机按三轮自动更新：

| 轮次 | 由什么触发 | 手机上显示 |
|---|---|---|
| 第一轮 | App 提交预约 | 已收到预约，请前往站台上车点；为你预留的位置 |
| 第二轮 | 摄像头看到对应的辅具进入站台区域（触发信号一） | 已识别你到站，公交正在进站；公交孪生动画 |
| 第三轮 | 乘客在站台停留后朝车的方向离开区域（触发信号二） | 上车指引、分配的座位或轮椅位编号、车内分段导航、上车动画 |

约定：

- **手机和 dashboard 显示同一份内容。** 阶段、文字、座位都由中枢决定，App 只负责显示，不自己推断流程。
- **演示方式：一部手机，依次扮演多位乘客。** 例如先约轮椅，上车后按 "Finish"，再约婴儿车，再约手杖……每次只有一位乘客在流程中。
- **结束一位、开始下一位。** 第三轮（已上车、显示车内步骤）时，步骤下方有 "Finish" 按钮：通知中枢这段旅程结束（中枢把车复位），手机清空本地状态并回到选类别的界面。中枢连不上也照样复位，不会卡住。
- **多部手机同时预约：能容忍，但不是演示目标。** 中枢保留等待名单（按预约先后），一次只让一位上车，摄像头看到哪种辅具就放行需求相同的那一单；同一类别同时只能有一单（再约会被 409 拒绝）；排队的手机显示"前面还有 N 位"等自己的状态。
- **类别不一致时只等待。** 例如预约的是轮椅、进站的是婴儿车，手机显示"请在站台等待"，车不开门。
- 文字用英文，与 dashboard 逐字一致。

---

## 2. 目前的实现

代码在 `app/`（原生 iOS，SwiftUI），已经按上面的需求改完并合入 main。

| 内容 | 状态 |
|---|---|
| 选类别、提交预约、取消 | 已有，中枢实测接受 |
| 读取中枢的旅程（`journey`）和导航（`navigation`） | 已实现 |
| 三轮界面：三步进度条、指引标题和正文、座位或轮椅位、编号的车内步骤 | 已实现 |
| 公交孪生动画：在 App 里用网页视图打开 dashboard 的 `/passenger-twin` 页面 | 已实现 |
| 类别不一致、被判为没有上车、取消、过期 | 已实现，显示中枢给的文字 |
| 中枢没有旅程数据时（旧版本中枢） | 保持原来的行为 |
| 等待名单：跟自己那一条 `journeys`、排队行、`waiting_turn`/`no_place`、409、取消带 `cancels` | 已实现（中枢侧同时在做，尚未和真实中枢联调） |

**没有做的验证：这份代码还没有用 Xcode 编译过。** 写代码的机器没有 Xcode，只做了这些检查：核心逻辑和三个界面文件用 macOS 的 Swift 做了类型检查（iOS 专用的部分换成 macOS 的等价写法）；`HubBookingTests` 30 项单元测试运行通过（含一部手机依次多位乘客、Finish 时中枢连不上、三部手机排队的场景）；`boarding_ui_fixture.py` 输出的数据能被解码。

---

## 3. 你需要做什么

1. **拉取 main，用 Xcode 编译并装到手机。** 步骤见 `app/docs/hub-v05-gap.md` 第 7 节（签名团队和 Bundle Identifier 要换成自己的）。
2. **如果编译报错，把完整报错发回来，不要自己改完再推。** 我们一次修完再合入，避免两边来回同步。最可能出错的位置：
   - `app/BusPulse SG/Features/Assistance/PassengerTwinView.swift`（网页视图，只按 macOS 的写法检查过）
   - `app/BusPulse SG/Features/Assistance/AssistanceStatusView.swift` 第 226 行附近的 `switch`
   - 几个系统图标名（写错只会显示空白，不会报错）
3. **按第 5 节启动演示，对照第 4 节的时间表走一遍三种类别**，把手机上和预期不一致的地方记下来发回。
4. 之后的界面和文案小修改，按第 6 节找到对应文件直接改，提 PR。

---

## 4. App 怎样和其余部分衔接

三个模块只通过中枢交换信号，App 不直接和摄像头或 dashboard 通信。

```
 App ──POST /api/booking──► 中枢 ◄──POST /api/perception── 摄像头检测桥
  ▲                          │
  └──GET /api/state 或 /api/events（SSE）──┘   dashboard 读的是同一份状态
```

### 4.1 App 发出的

`POST /api/booking`，带 `Authorization: Bearer <token>`：

```json
{ "event_id": "app-<唯一编号>", "observed_at": "2026-10-03T08:00:00Z",
  "payload": { "active": true, "intent": "BOARDING", "route_id": "DEMO_ROUTE", "stop_id": "DEMO_STOP",
               "accessibility_need": "WHEELCHAIR", "ramp_preference": "REQUESTED",
               "assistance_requested": ["WHEELCHAIR_RAMP"], "preferred_interaction": "BOTH", "language": "en-SG" } }
```

- `event_id` 就是这次旅程的编号，中枢返回的 `journey_id` 与它相同。App 只认编号等于自己这次预约的旅程。
- 接受：`202 {accepted: true, journey_id, queued, position}`。`queued`/`position` 是新字段（排队时为 true / 前面有几单），旧中枢只回 `accepted`。
- 拒绝：同类别已有一单时 `409 {error: "NEED_ALREADY_BOOKED", need, existing_journey_id}`。App 显示 "A request for this type of assistance is already active. Please try again after that passenger has boarded."，不自动重试；用户点 Try Again 时重新生成 `observed_at` 再发。
- 取消：同样的格式，`active: false`，并在 `payload` 里加 `cancels: "<要取消的那单的 event_id>"`。旧中枢的预约 schema 允许多余字段并在入库前丢弃，所以旧中枢照样接受，只是不看 `cancels`。
- 结束：按 "Finish" 时发的就是上面这条取消（App 不用改）。手机和 dashboard 各自结束：对已上车（`completed`）的旅程，中枢只确认（202），dashboard 上的旅程、上车动画和车都不变，只在 `journeys[]` 里这一条加 `passenger_finished: true`。App 先清空本地状态再发请求，只发一次，失败或超时都忽略，不重试。手机随后预约下一位时，新预约立即开始，dashboard 切到新乘客，没有别人排队时换新车。
- dashboard 的 Reset 按钮发同样的取消，另加 `operator_reset: true`：只有带这个标记，已上车的旅程才立即结束（`reason: "completed"`，空闲画面，换新车）。没上车时，手机取消和 Reset 都是普通取消（`reason: "cancelled"`）。
- 手机时钟比电脑快 5 秒以上时，中枢会拒收（`observed_at` 在未来）。

### 4.2 App 读取的

`GET /api/state`，或订阅 `GET /api/events`。

**用哪一条旅程。** 顶层的 `journey`、`navigation`、`result` 描述的是正在服务的那位乘客（不一定是自己）。新中枢另给 `journeys` 数组：每单一条，按预约先后排列，包括排队中、进行中、以及 2 分钟内结束的单；每条的字段和 `journey` 相同，另有 `queued`、`position`（前面还有几单）、`plan_status` 和这一单自己的 `navigation`。App 的规则：

- 有 `journeys`：只用 `journey_id` 等于自己 `event_id` 的那一条和它自己的 `navigation`；`result`（座位方案、播报）只在这一单正在服务时才算自己的。
- 有 `journeys` 但里面没有自己：视为中枢已结束这单（刚预约的前 10 秒除外）。已经上车的显示 "Journey finished"，没上车的显示 "Booking expired"。不再退回旧的触发信号逻辑。
- 条目 `reason: "completed"`（dashboard 按 Reset 后）：正常结束，显示 "Journey finished" 和 "Finish" 按钮，不显示 "Booking cancelled"。
- 结束后马上约下一位：上一单的条目还会在 `journeys` 里留约 2 分钟，App 只认新预约的 `event_id`，不受影响。
- 没有 `journeys`（旧中枢）：和以前一样，只认 `journey.journey_id` 等于自己的 `journey`。
- 中枢还列着这单、而且没有结束时（排队中、在站台冻结、已上车），App 不再按自己的 300 秒计时判过期，以中枢为准。

字段：

| 字段 | 含义 | App 用来做什么 |
|---|---|---|
| `journey.stage` | `IDLE` / `BOOKED` / `AT_STOP` / `ON_BOARD` | 切换三轮界面 |
| `journey.matched` | 进站的辅具是否与预约一致 | 第二轮显示"已识别"还是"请等待" |
| `journey.guidance.title` / `display_text` / `audio_text` | 这一刻该告诉乘客的话 | 直接显示和朗读 |
| `journey.boarding_target` | `{type: "SEAT", id: "S03"}` 或 `{type: "WHEELCHAIR_BAY", …}` | 显示分配的位置 |
| `journey.equipment_target` / `navigation.equipment_target` | 婴儿车：`{type: "WHEELCHAIR_BAY", id: "WHEELCHAIR_BAY"}`（推车停放位置）；其他类别为 null | 婴儿车乘客的座位仍是 `boarding_target`；推车停在轮椅位。可在座位旁加一行 "Stroller: wheelchair bay"（目前 App 未显示） |
| `navigation.steps` | 车内分段导航，上车后才有内容；婴儿车有 15 步，其中一步 `maneuver: "PARK_STROLLER"`（把推车停进轮椅位） | 第三轮的编号步骤（`PARK_STROLLER` 目前显示默认箭头图标，可换成推车图标） |
| `journey.animation` | `{id, phase, aid, started_at, duration_ms}` | 孪生页自己使用，App 不用处理 |
| `journey.reason` | `booked` / `entered` / `unmatched` / `not_boarding` / `left_stop` / `boarding_preview` / `cancelled`；新增 `completed`（上车后 dashboard 按 Reset，正常结束）、`waiting_turn`（已到站，但前一位正在上车）、`no_place`（这辆车没有无障碍位置了，等工作人员） | 补充提示；后两种用黄色等待样式显示中枢的文字 |
| `journey.revision` | 每次变化加一 | 丢弃迟到的旧状态 |
| `journeys[].queued` / `position` | 是否在排队 / 前面还有几单 | 第一轮下方加一行 "N passengers ahead of you"（文字仍以 guidance 为准） |
| `journeys[].navigation` | 这一单自己的导航，排队时为 null | 第三轮的编号步骤 |

阶段可以从 `AT_STOP` 回到 `BOOKED`（不匹配的人离开，或乘客被判为没有上车），App 已按此处理。

### 4.3 时间关系

以仓库自带的回放为例（时间从预约算起）：

| 时间 | 中枢 | 手机 |
|---|---|---|
| 0 秒 | `BOOKED` | 第 1 步；"Go to the bus stop"；预留位置 |
| 约 5 秒 | 触发信号一 → `AT_STOP`，`matched` | 第 2 步；"Bus arriving"，约 4 秒后 "Preparing to board"；孪生里公交驶入 |
| 约 14 秒 | 触发信号二到达，先挂起 | 不变 |
| 约 15 秒 | `ON_BOARD` | 第 3 步；位置大字；孪生播放上车动画；车内步骤；步骤下方出现 "Finish" |
| 按下 Finish | 收到 `cancels`，只记 `passenger_finished: true`；dashboard 继续显示已上车和动画，直到操作员按 Reset 或下一位预约 | 立即回到选类别界面，可以约下一位 |

公交进站动画固定 10 秒。乘客在这之前离开区域，中枢会等动画结束再进入第三轮。同一辆车的后几位乘客，车已经停在站台，进站阶段（`animation.phase: "arrival"`）的 `duration_ms` 更短；孪生页在 5 秒以内时不再播放驶入，直接开门、放坡道。

排队中的手机显示什么：

| 中枢（这一单的 `journeys` 条目） | 手机 |
|---|---|
| `BOOKED`，`queued`，`position: 2` | 第 1 步；中枢的标题和正文；下面一行 "2 passengers ahead of you"；不显示孪生动画 |
| `position` 变为 1 | 同上，"1 passenger ahead of you" |
| `reason: "waiting_turn"` | 黄色等待框，显示中枢的文字；"You are next."（前面没人时） |
| `reason: "no_place"` | 黄色提示框，显示中枢的文字；不显示排队行 |
| 轮到自己：`AT_STOP`、不再 `queued` | 第 2 步；出现孪生动画（车已停站，直接开门） |
| `ON_BOARD` | 第 3 步，和单人时相同 |
| 从 `journeys` 里消失 | 未上车：显示 "Booking expired"；已上车：显示 "Journey finished" |

孪生动画显示的是正在服务的那位乘客，所以只在这一单正在服务（不在排队）时才显示，避免排队的人把别人的上车当成自己的。

### 4.4 孪生动画页

App 打开的地址是 `http://<中枢所在电脑的 IP>:3000/passenger-twin#token=<token>`，由 App 根据设置里的主机和 token 自动生成，dashboard 端口固定 3000。页面加载失败时 App 只显示文字，流程不受影响。

---

## 5. 演示怎样启动

在运行中枢的电脑上（环境安装见 HANDOFF.md 3.2 节）：

```bash
read -s DEEPSEEK_API_KEY && export DEEPSEEK_API_KEY     # 粘贴 key 后回车；没有 key 就跳过这一行，在 dashboard 里选 Offline rules
LAN=1 bash start_demo.sh demos/captures/venue
```

- 不需要摄像头。这是回放模式：收到预约后，按预约的类别播放对应的现场录像片段（轮椅、婴儿车、手杖），并在同样的时刻发出触发信号一和二。其他类别（如 Walker）没有对应片段，会显示不匹配。
- 终端会打印电脑的 IP 和访问 token。
- 手机和电脑连同一个网络，在 App 的 Settings → BusTech signal hub 里打开开关，填 IP、端口 `8787` 和 token。第一次连接要允许"本地网络"权限。
- 在电脑浏览器打开 `http://127.0.0.1:3000` 看 dashboard，和手机对照。

没有手机时，用命令代替 App 发预约（把 `WHEELCHAIR` 换成 `STROLLER` 或 `CANE` 试其他类别）：

```bash
curl -X POST http://127.0.0.1:8787/api/booking -H 'Content-Type: application/json' \
  -d '{"event_id":"app-'$(date +%s)'","observed_at":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'","payload":{"active":true,"intent":"BOARDING","route_id":"DEMO_ROUTE","stop_id":"DEMO_STOP","accessibility_need":"WHEELCHAIR","ramp_preference":"REQUESTED","assistance_requested":["WHEELCHAIR_RAMP"],"preferred_interaction":"BOTH","language":"en-SG"}}'
```

LAN 模式下命令要加 `-H 'Authorization: Bearer <token>'`。

---

## 6. 以后做小修改，改哪里

### App（`app/BusPulse SG/`）

| 想改什么 | 文件 |
|---|---|
| 三轮界面的布局、颜色、图标、按钮（含 "Finish"）；排队行、`waiting_turn`/`no_place` 的黄色框 | `Features/Assistance/AssistanceStatusView.swift` |
| 排队行的文字（"N passengers ahead of you"） | `Core/Assistance/HubBookingContract.swift`（`HubJourney.queueText`） |
| 409 等被拒时的提示文字 | `Core/Assistance/HTTPVehicleCloudService.swift`（`errorDescription`） |
| 三步进度条 | `Features/Assistance/AssistanceComponents.swift`（`AssistanceJourneyProgress`） |
| 可选的辅助类别、每个类别的名称和图标 | `Core/Assistance/AssistanceModels.swift` |
| 选类别的界面 | `Features/Assistance/ManualAssistanceSelectionView.swift` |
| 预约里发送的字段 | `Core/Assistance/HubBookingContract.swift`、`HTTPVehicleCloudService.swift` |
| 从中枢读取的字段 | `Core/Assistance/HubBookingContract.swift`（`journey`、`navigation`、`journeys` 的结构） |
| 阶段怎样映射到界面、用哪一条旅程、何时播报；Finish 时怎样复位（`finish`） | `Core/Assistance/AssistanceRequestService.swift`（`applyJourney`） |
| 孪生动画页的地址、加载失败的处理 | `Features/Assistance/PassengerTwinView.swift`、`Core/Persistence/PreferencesStore.swift` |
| 中枢地址和 token 的设置界面 | `Features/Settings/` |

### 手机上显示的文字

文字由中枢生成，改一处，手机和 dashboard 同时变：`dashboard/backend/journey.mjs` 里的 `guidance()`。改完运行 `cd dashboard && npm test`。

### 其他模块

| 想改什么 | 文件 |
|---|---|
| dashboard 页面布局和样式（含等待名单那一行） | `dashboard/app/live-dashboard.tsx`、`dashboard/app/live.css` |
| dashboard 里的摄像头面板、孪生面板 | `dashboard/app/components/VideoPanel.tsx`、`TwinPanel.tsx` |
| 手机里嵌入的孪生页 | `dashboard/app/passenger-twin/page.tsx` |
| 孪生动画的步骤和时长（含车已停站时跳过驶入，`DOCKED_ARRIVAL_MAX_MS`） | `dashboard/app/lib/twinScenario.ts` |
| 公交模型、车厢、乘客小人 | `twin/src/`，改完运行 `bash twin/sync_to_dashboard.sh` |
| 旅程阶段怎样推进、进站动画时长（10 秒） | `dashboard/backend/journey.mjs` |
| 座位怎样分配、哪些动作被允许 | `dashboard/backend/planner/policy.mjs` |
| 大模型的提示词 | `dashboard/backend/prompts/system_prompt.txt` |
| 进站和离站的判定时间、上车方向 | `vision/yolo_bridge.py` 的 `--enter-seconds`、`--exit-seconds`、`--min-dwell`、`--board-direction` |
| 回放用的录像片段 | `demos/captures/venue/`，制作方法见 HANDOFF.md 3.7 节 |

改接口（新增或改动字段）之前，先改 `PROMPT.md` 并通知相关模块；只改界面和文案不需要。
