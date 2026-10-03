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
- **一次只服务一位乘客。** 摄像头可以同时看到多种辅具，但上车有先后；中枢同一时间只跟一位已预约的乘客，上车完成后才接下一次预约。不需要处理多人同时上车。
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

**没有做的验证：这份代码还没有用 Xcode 编译过。** 写代码的机器没有 Xcode，只做了这些检查：核心逻辑和三个界面文件用 macOS 的 Swift 做了类型检查（iOS 专用的部分换成 macOS 的等价写法）；旅程相关的 22 项单元测试运行通过；中枢真实返回的数据能被解码。

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

- `event_id` 就是这次旅程的编号，中枢返回的 `journey.journey_id` 与它相同。App 只认编号等于自己这次预约的旅程。
- 取消：同样的格式，`active: false`。
- 手机时钟比电脑快 5 秒以上时，中枢会拒收（`observed_at` 在未来）。

### 4.2 App 读取的

`GET /api/state`，或订阅 `GET /api/events`。只需要这几个字段：

| 字段 | 含义 | App 用来做什么 |
|---|---|---|
| `journey.stage` | `IDLE` / `BOOKED` / `AT_STOP` / `ON_BOARD` | 切换三轮界面 |
| `journey.matched` | 进站的辅具是否与预约一致 | 第二轮显示"已识别"还是"请等待" |
| `journey.guidance.title` / `display_text` / `audio_text` | 这一刻该告诉乘客的话 | 直接显示和朗读 |
| `journey.boarding_target` | `{type: "SEAT", id: "S03"}` 或 `{type: "WHEELCHAIR_BAY", …}` | 显示分配的位置 |
| `navigation.steps` | 车内分段导航，上车后才有内容 | 第三轮的编号步骤 |
| `journey.animation` | `{id, phase, aid, started_at, duration_ms}` | 孪生页自己使用，App 不用处理 |
| `journey.reason` | `booked` / `entered` / `unmatched` / `not_boarding` / `left_stop` / `boarding_preview` / `cancelled` | 补充提示 |
| `journey.revision` | 每次变化加一 | 丢弃迟到的旧状态 |

阶段可以从 `AT_STOP` 回到 `BOOKED`（不匹配的人离开，或乘客被判为没有上车），App 已按此处理。

### 4.3 时间关系

以仓库自带的回放为例（时间从预约算起）：

| 时间 | 中枢 | 手机 |
|---|---|---|
| 0 秒 | `BOOKED` | 第 1 步；"Go to the bus stop"；预留位置 |
| 约 5 秒 | 触发信号一 → `AT_STOP`，`matched` | 第 2 步；"Bus arriving"，约 4 秒后 "Preparing to board"；孪生里公交驶入 |
| 约 14 秒 | 触发信号二到达，先挂起 | 不变 |
| 约 15 秒 | `ON_BOARD` | 第 3 步；位置大字；孪生播放上车动画；车内步骤；按钮变成 Done |

公交进站动画固定 10 秒。乘客在这之前离开区域，中枢会等动画结束再进入第三轮。

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
| 三轮界面的布局、颜色、图标、按钮 | `Features/Assistance/AssistanceStatusView.swift` |
| 三步进度条 | `Features/Assistance/AssistanceComponents.swift`（`AssistanceJourneyProgress`） |
| 可选的辅助类别、每个类别的名称和图标 | `Core/Assistance/AssistanceModels.swift` |
| 选类别的界面 | `Features/Assistance/ManualAssistanceSelectionView.swift` |
| 预约里发送的字段 | `Core/Assistance/HubBookingContract.swift`、`HTTPVehicleCloudService.swift` |
| 从中枢读取的字段 | `Core/Assistance/HubBookingContract.swift`（`journey`、`navigation` 的结构） |
| 阶段怎样映射到界面、何时播报 | `Core/Assistance/AssistanceRequestService.swift`（`applyJourney`） |
| 孪生动画页的地址、加载失败的处理 | `Features/Assistance/PassengerTwinView.swift`、`Core/Persistence/PreferencesStore.swift` |
| 中枢地址和 token 的设置界面 | `Features/Settings/` |

### 手机上显示的文字

文字由中枢生成，改一处，手机和 dashboard 同时变：`dashboard/backend/journey.mjs` 里的 `guidance()`。改完运行 `cd dashboard && npm test`。

### 其他模块

| 想改什么 | 文件 |
|---|---|
| dashboard 页面布局和样式 | `dashboard/app/live-dashboard.tsx`、`dashboard/app/live.css` |
| dashboard 里的摄像头面板、孪生面板 | `dashboard/app/components/VideoPanel.tsx`、`TwinPanel.tsx` |
| 手机里嵌入的孪生页 | `dashboard/app/passenger-twin/page.tsx` |
| 孪生动画的步骤和时长 | `dashboard/app/lib/twinScenario.ts` |
| 公交模型、车厢、乘客小人 | `twin/src/`，改完运行 `bash twin/sync_to_dashboard.sh` |
| 旅程阶段怎样推进、进站动画时长（10 秒） | `dashboard/backend/journey.mjs` |
| 座位怎样分配、哪些动作被允许 | `dashboard/backend/planner/policy.mjs` |
| 大模型的提示词 | `dashboard/backend/prompts/system_prompt.txt` |
| 进站和离站的判定时间、上车方向 | `vision/yolo_bridge.py` 的 `--enter-seconds`、`--exit-seconds`、`--min-dwell`、`--board-direction` |
| 回放用的录像片段 | `demos/captures/venue/`，制作方法见 HANDOFF.md 3.7 节 |

改接口（新增或改动字段）之前，先改 `PROMPT.md` 并通知相关模块；只改界面和文案不需要。
