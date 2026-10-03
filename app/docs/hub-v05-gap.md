# BusPulse SG 对接 v0.5 中枢：差距与改动清单

> 写给 App 负责人。基于 `integrate-v05` 分支上的 `dashboard/backend/{hub,journey,server}.mjs`、`planner/contracts.mjs`，
> 以及 `app/` 下已提交的 Swift 代码（本机无 Xcode，未编译、未跑 Swift 测试）。下文 JSON 是 2026-10-03 在本机
> 用真实中枢代码（rules 模式，端口 8897，带 token）按 App 的原始请求格式跑出来的，只删了部分字段。
> 行号以提交 `9fc80ee` 为准。dashboard 正在修改 `journey.mjs`，新增规则：`exit` 带 `zone.boarding:false`（人没有朝车走）时
> 回到 BOOKED，而不是 `pending_exit`。修改后 `journey.mjs` 第 37 行之后的行号会后移 2 行，App 侧结论不变。

## 实施状态（2026-10-03 更新）

本文第 1–5 节是改动前的分析，保留作对照。App 侧已按第 4 节实现，**本机无 Xcode，未在模拟器/真机编译运行**；
`Core/` 与改动的视图在 macOS SDK 上以 Swift 6 做了类型检查（UIKit 专有 API 用替身），`HubBookingTests` 22 个用例在 macOS 上用
SwiftPM 实际跑通，真实中枢的 `/api/state` 也能解码。

| 清单项 | 状态 | 位置 |
|---|---|---|
| P0 解码 `journey` / `navigation` | 已完成；全部可选，`journey` 格式异常时退回旧逻辑 | `HubBookingContract.swift`（`HubJourney`、`HubNavigation`、`HubSnapshot.init(from:)`） |
| P0 以 stage 驱动 | 已完成：`journey.journey_id == 本单 event_id` 时按 `stage+matched` 显示，可从 AT_STOP 回到 BOOKED；不再用 trigger 锁存、`busIsAtStop`、10 s 窗口、ROI；轮询与 SSE 乱序时不回退到旧 revision | `AssistanceRequestService.applyJourney` |
| P0 文案统一 | 已完成：标题/正文为 `journey.guidance`，播报 `title. audio_text`；同一单的同一句话只播一次（新 revision 但文案不变不重播，回到旧文案会再播） | `AssistanceStatusView.announceHubFeedback`、`takeJourneyFeedback` |
| P1 座位/轮椅位、分步导航 | 已完成：第 3 轮大字显示 `Wheelchair bay` / `Seat S03`，列出 `navigation.steps`（为空时显示 guidance 正文）；第 1 轮显示 "Reserved for you" | `AssistanceStatusView.journeyContent` |
| P1 动画 | 已完成（方式改为内嵌 dashboard 数字孪生）：AT_STOP+matched 与 ON_BOARD 时用 WKWebView 加载 `http://<中枢 IP>:3000/passenger-twin#token=<token>`，加载失败只显示文字 | `PassengerTwinView.swift`、`dashboard/app/passenger-twin/page.tsx` |
| P2 过期/取消 | 已完成：`IDLE+cancelled/expired` 显示中枢文案并结束；`completed` 后不再做本地 300 s 过期；`not_boarding` 回到第 1 轮并加一句提示 | 同上 |
| P2 测试 | 已完成：`HubBookingTests`（旧用例改名为 Legacy，新增场馆场景、乱序、取消、URL）；`boarding_ui_fixture.py` 输出 journey；`SignalTwoUITests` 改为按三轮断言 | — |
| 等待名单（多部手机） | 已完成，按约定字段编写，**尚未与实现了等待名单的中枢联调**：有 `journeys` 时只跟 `journey_id == 本单 event_id` 的条目及其 `navigation`，没有本单视为已结束（前 10 s 宽限；已上车的保留）；排队行 "N passengers ahead of you"；`waiting_turn`/`no_place` 黄色框；排队时不显示孪生；中枢仍列着本单时不做本地 300 s 过期；409 `NEED_ALREADY_BOOKED` 提示且不自动重试；取消带 `cancels`（旧中枢会丢弃该字段）；没有 `journeys` 的中枢行为不变 | `HubBookingContract.swift`（`HubJourneyEntry`、`ownEntry`）、`AssistanceRequestService.applyJourney`、`HTTPVehicleCloudService`、`AssistanceStatusView.journeyContent` |
| 一部手机依次多位乘客 | 已完成：第 3 轮步骤下方 "Finish"：先清空本地会话并回到选类别，再向中枢发一次带 `cancels` 的取消（中枢视为复位，失败忽略、不重试）；`reason: "completed"` 和上车后从 `journeys` 消失都显示 "Journey finished"；下一单只认新 `event_id` | `AssistanceRequestService.finish`、`AssistanceStatusView.hubCard` |
| P2 测试（等待名单） | 已完成：`HubBookingTests` 新增 5 个用例（共 27 个，macOS SwiftPM 跑通）；`boarding_ui_fixture.py` 输出 `journeys`，新增阶段 7–10 和 `/test/reject` | — |
| 仍未做 | 中文文案（中枢只有英文）；按 `aid` 选本地动画（改用孪生）；`scripts/test-bustech-integration.mjs` 写死的 Xcode 路径；没有 journey 的旧中枢仍走旧逻辑 | — |

**LAN 阻塞点**：Next 16 开发服务器默认拦截非 localhost 来源的开发资源（HMR websocket），用局域网 IP 打开页面时
**React 不会完成 hydration**（孪生 iframe 能显示，但不会连中枢、不会动）。本机实测：`http://localhost:3106/passenger-twin` 正常跟随中枢，
`http://<LAN IP>:3106/passenger-twin` 停在 "Loading twin…"。需要集成方在 `dashboard/next.config.ts` 加
`allowedDevOrigins: ['192.168.*.*', '10.*.*.*', '172.*.*.*']`（或具体 IP）后重启。手机浏览器打开主 dashboard 也受同样影响。

## 0. 结论

- **预约能通**：App 发送的字段全部在 v0.5 schema 内（见第 1 节），`POST /api/booking` 返回 202；`/api/state` 和 SSE
  仍能被现有 `HubSnapshot` 解码（`source/channels/running/result/context` 都还在）。
- **三轮反馈不对**：App 没有读 `journey` / `navigation`，而是用 `zone.triggered`、`zone.event=="exit"` 和
  `vehicle_context` 自己推断阶段。在联调回放里会出现：**先来的婴儿车（不匹配）就让手机显示 "The bus is here"，
  婴儿车离开又显示 "Please board the bus"，并且锁住**，之后真正的轮椅到站和上车都不再更新。
- **缺少的功能**：第二轮"已识别/不匹配"文案、座位/轮椅位编号（只间接出现在 `result.passenger_communication` 文本里）、
  车内分步导航、按类别的上车动画，都还没有。

## 1. App 现在发什么、读什么

| 项 | 代码位置 | v0.5 是否接受 / 提供 |
|---|---|---|
| `event_id`=`app-booking-<UUID>`，取消用新 `app-cancel-<UUID>` | `HTTPVehicleCloudService.swift:123-132` | 接受（`^[A-Za-z0-9_.:-]{1,80}$`，`hub.mjs:102`） |
| `observed_at` 手机 UTC 时间 | `HubBookingContract.swift:41-46` | 接受；**比中枢时钟快 >5 s 会 400 `INVALID_OBSERVED_AT`**（`hub.mjs:104`） |
| `intent` BOARDING/ALIGHTING/UNKNOWN | `HubBookingContract.swift:49` | 接受（`contracts.mjs:48`）；只有 `active && BOARDING` 才进入 BOOKED（`journey.mjs:16`） |
| `accessibility_need`：WHEELCHAIR/CRUTCH/CANE/WALKER/STROLLER/NONE/UNKNOWN/MOBILITY_ASSISTANCE/VISUAL_ASSISTANCE/HEARING_ASSISTANCE | `HubBookingContract.swift:67-76` | 全部在枚举内（`contracts.mjs:49`） |
| `assistance_requested`（5 个值，已去重） | `HubBookingContract.swift:78-88` | 全部在枚举内（`contracts.mjs:50`） |
| `ramp_preference`、`preferred_interaction`、`language`(en-SG/zh-CN) | `HubBookingContract.swift:3-21,57-58` | 接受；但 `journey.guidance` 只有英文，`language` 不影响文案 |
| `route_id`/`stop_id` | `AssistanceModels.swift:231-235` 本地已按 id 正则校验 | 接受；`DEMO_ROUTE`/`DEMO_STOP` 会被中枢说成 "route 400 / the demo bus stop" |
| 解码 `source, channels.*.{event_id,observed_at}, running, result, context.request/perception.zone/vehicle_context` | `HubBookingContract.swift:104-175` | 仍提供，解码不报错 |
| 解码 `result.{request_id,plan_status,simulated,execution_authorized,passenger_communication}` | `HubBookingContract.swift:104-123` | 仍提供；**`boarding_target`、`cabin_navigation` 未解码** |
| **未解码**：`journey`、`navigation` | — | v0.5 的主要输出 |
| SSE：只处理 `snapshot` 和 `signal`，忽略 `navigation`/`result`/`planning`… | `HTTPVehicleCloudService.swift:160-179` | 每次变化中枢都会再发 `snapshot`（`hub.mjs:46-53`），不丢状态 |

## 2. App 自己的逻辑与中枢 journey 的冲突

1. **"车已到站"判断永远为真**：`busIsAtStop`（`HubBookingContract.swift:152-160`）要求 `vehicle_context` 线路/站点匹配、
   STOPPED、手刹、age≤1500。v0.5 的 `vehicle_context` 是固定夹具，线路站点直接抄预约，`observation_age_ms:0`
   （`hub.mjs:33-35`），所以只要有一次 trigger，`AssistanceStatusView.swift:154` 就直接进入 "The bus is here" 卡片，
   第二轮 "You're all set!"（`:167-183`）几乎看不到。
2. **不看 `matched`**：`hasTrigger`（`HubBookingContract.swift:177-180`）只看 `zone.triggered==true`。婴儿车不匹配时中枢是
   `AT_STOP, matched:false, guidance "Please wait at the stop"`，App 却显示到站/上车。
3. **锁存，不会回退**：`recordTrigger`（`AssistanceRequestService.swift:147-162`）只在 `triggeredAt==nil` 时记一次，并记下
   这次的 `roi_id`。中枢在不匹配的人离开后会回到 `BOOKED`（`journey.mjs:40-42`），App 不会回退。
4. **第三轮用错信号**：`hasExitTrigger`（`HubBookingContract.swift:186-193`）把任何同 ROI 的 `exit` 当作上车。中枢只在
   `matched` 且 `left` 类别一致时设 `pending_exit`，并且要等到站动画满 10 s（`ARRIVAL_MS`）才进 `ON_BOARD`
   （`journey.mjs:38-39,58-61`）。回放里轮椅停留约 9 s，手机会比中枢早约 1 s 说"上车"。
5. **10 秒窗口和时钟**：`hasCurrentPerception`（`HubBookingContract.swift:195-205`）要求感知 `observed_at`（来自摄像头那台
   Mac 的时钟）距手机当前时间 ≤10 s 且不早于提交时间。两台设备时钟偏差大时会漏掉或误判。改读 `journey` 后不再需要。
6. **5 分钟过期**：App 在 `AssistanceRequestService.swift:107,152` 和 `HubBookingContract.swift:213` 按提交时间 300 s 一律过期。
   中枢对 `completed:true` 的旅程不再过期（`hub.mjs:70,82`），会出现中枢仍是 ON_BOARD、手机显示 "Booking expired"。
   中枢过期时会把 `context.request.active` 改成 false（`hub.mjs:32`），旧逻辑会先命中 `.cancelled`（`HubBookingContract.swift:211`），
   显示成"已取消"，而不是"已过期"。应读 `journey.reason`。
7. **文案不同**：第一轮 App 显示自己的 "Please proceed to" + 站牌（`AssistanceStatusView.swift:184-190`），第三轮显示
   `result.passenger_communication.display_text`（`:160`）。这段文本由规则模板生成，`display_text` 可能为 null
   （`policy.mjs:274`），此时 `takeBoardingFeedback` 不播报（`AssistanceRequestService.swift:193-194`）。dashboard 显示的是
   `journey.guidance`。

## 3. 对照表

| 流程环节 | 中枢现在提供的字段 | App 现在怎么做 | 需要改什么 |
|---|---|---|---|
| 第 1 轮：预约后"去车站" | `journey.stage=="BOOKED"`；`journey.guidance.{title,display_text,audio_text}`（方案未 READY 时为 "Booking received"）；`navigation.phase=="TO_STOP"`、`destination` | 自己的 "Request received by bus / Please proceed to" + 站牌 | 标题和正文改用 `journey.guidance`，站牌可保留为辅助 |
| 第 2 轮：已识别 | `stage=="AT_STOP" && matched`；guidance 依次为 "Bus arriving"（0–4.2 s）、"Preparing to board"（4.2–10 s）、"Ready to board"（≥10 s 且人未离开，此时 `navigation.phase=="BOARD_BUS"`） | 任意 `zone.triggered` 就锁存；实际直接显示 "The bus is here" | 按 `stage+matched` 显示；guidance 变化时更新并播报 |
| 第 2 轮：不匹配 | `stage=="AT_STOP" && !matched`，`reason:"unmatched"`，guidance "Please wait at the stop…"；不匹配的人离开后回到 `BOOKED` | 当作到站，并且锁存 | 显示等待安全员；允许回到第 1 轮 |
| 离开后待上车 | `pending_exit:true`（到站准备未满 10 s） | 立刻显示 "Please board the bus" | 继续显示 guidance，不提前说上车 |
| 第 3 轮：上车 | `stage=="ON_BOARD"`、`completed:true`、`reason:"boarding_preview"`；guidance 为车内路线全文 | 依靠自己检测的 exit | 按 stage 进入第 3 轮 |
| 座位 / 轮椅位 | `journey.boarding_target {type:"SEAT"|"WHEELCHAIR_BAY", id}`，`journey.seat`（规划完成后第 1 轮就有）；ON_BOARD 时也在 `navigation.destination` | 未解码，只在 passenger_communication 文本里出现 | 第 3 轮显示大号编号（如 "S02" / "Wheelchair bay"），也可在第 1 轮显示"已为你预留" |
| 车内分步导航 | `navigation.steps[]`：`{step, maneuver: START/STRAIGHT/TURN_LEFT/TURN_RIGHT/ARRIVE, distance_m|null, text}`，仅 ON_BOARD 非空；`navigation.cabin_route.steps` 规划完成后就有 | 无 | 第 3 轮列出步骤，maneuver 用图标；距离是模拟近似值，不做逐步完成判定 |
| 动画 | `journey.animation`: `{id, phase:"arrival"|"boarding", aid, started_at(中枢 epoch ms), duration_ms(10000/16000), target}`；aid 为 wheelchair/stroller/cane/crutch/walker/visual/hearing/none | 无 | 按 `id` 去重（心跳、重连不重播）；进度=(中枢现在−started_at)/duration_ms，用 SSE 事件的 `at` 或 HTTP `Date` 估算时钟差；`aid` 选类别动画 |
| 取消 / 过期 / 被替换 | `stage=="IDLE"`，`reason` 为 `cancelled`/`expired`；`navigation:null`；被别人预约替换时 `journey.journey_id` 不再是本单 | 本地 300 s 计时加 `channels.booking.event_id` 比对 | 用 `journey.journey_id` 比对（取消后变成本单的 `app-cancel-…` id，`journey.mjs:17`），按 `reason` 显示；本地 300 s 只在 `completed==false` 时兜底 |

## 4. 最小改动清单（按优先级）

1. **P0 解码新字段**：在 `HubSnapshot`（`HubBookingContract.swift:125`）加可选的 `journey` 和 `navigation`：
   `journey.{journey_id, revision, stage, need, matched, pending_exit, completed, reason, seat, boarding_target{type,id}, animation{id,phase,aid,started_at,duration_ms}, guidance{title,display_text,audio_text}}`，
   `navigation.{phase, destination{type,id}, instruction, steps[{step,maneuver,distance_m,text}], cabin_route.steps}`。全部设为可选，旧中枢也能解码。
2. **P0 以 stage 驱动 UI**：只在 `journey.journey_id == receipt.providerReference`（或本单取消 id）时采用，否则显示 `.replaced`。
   `AssistanceStatusView.hubCard`（`:145-211`）按 BOOKED / AT_STOP+matched / AT_STOP+!matched / ON_BOARD / IDLE 分支。
   删除或停用 `hasTrigger`、`hasExitTrigger`、`busIsAtStop`、`triggeredAt/triggerROI` 锁存、10 s 窗口（`AssistanceRequestService.swift:147-198`）。
3. **P0 文案统一**：显示 `journey.guidance.title` + `display_text`，朗读 `audio_text`；按 `journey.revision`（或 guidance 文本）去重，
   代替 `takeBoardingFeedback` 的 key（`:195`）。
4. **P1 座位/轮椅位**：读 `journey.boarding_target`，第 3 轮突出显示。
5. **P1 车内导航**：第 3 轮显示 `navigation.steps`（为空时退回 `guidance.display_text`）。
6. **P1 上车动画**：读 `journey.animation`，按 `id` 去重，按 `started_at/duration_ms` 续播，`aid` 选素材；`phase:"arrival"` 可做"公交进站"小动画。
7. **P2 过期/取消**：读 `journey.reason`；本地 300 s 仅在未 `completed` 时生效；时钟偏差提示沿用 `INVALID_OBSERVED_AT` 文案。
8. **P2 测试**：更新 `HubBookingTests.swift:167-316` 中基于 trigger 的用例；`scripts/boarding_ui_fixture.py` 要返回 `journey`/`navigation`；
   `scripts/test-bustech-integration.mjs:49` 写死了 `/Applications/Xcode-beta.app` 和 `iPhone 17 Pro Max, OS=27.0`。

## 5. 各阶段真实 `/api/state` 片段

预约 CANE，路线 190，站点 09048，rules 模式。省略了 `context`、`channels`、`result`、`summary`；`audio_text` 与 `display_text` 相同，因此省略。

```jsonc
// BOOKED（规划 READY 后）
{"journey":{"journey_id":"app-booking-E7C1…","revision":2,"stage":"BOOKED","need":"CANE","matched":false,"seat":"S02",
 "boarding_target":{"type":"SEAT","id":"S02"},"completed":false,"pending_exit":false,"animation":null,"reason":"booked",
 "guidance":{"title":"Go to the bus stop","display_text":"Please go to the marked boarding point at 09048 for route 190. Your assistance plan is ready."}},
 "navigation":{"phase":"TO_STOP","destination":{"type":"BUS_STOP","id":"09048"},"steps":[],"cabin_route":{"steps":[…7 步]}}}
// AT_STOP，不匹配（婴儿车）
{"journey":{"revision":3,"stage":"AT_STOP","labels":["STROLLER"],"matched":false,"reason":"unmatched","animation":null,
 "guidance":{"title":"Please wait at the stop","display_text":"The detected assistance does not match the booking. Please wait for the safety operator."}},
 "navigation":{"phase":"WAIT_AT_STOP"}}
// AT_STOP，匹配，到站动画开始（4.2 s 后 title 变为 "Preparing to board"）
{"journey":{"revision":6,"stage":"AT_STOP","labels":["CANE"],"matched":true,"pending_exit":false,"reason":"entered",
 "animation":{"id":"app-booking-E7C1…:legacy:5:arrival","phase":"arrival","aid":"cane","started_at":1791014597145,"duration_ms":10000,"target":{"type":"SEAT","id":"S02"}},
 "guidance":{"title":"Bus arriving","display_text":"We have recognised you at the bus stop. The bus is arriving; please stay behind the marked boarding line."}},
 "navigation":{"phase":"WAIT_AT_STOP"}}
// 10 s 内离开：pending_exit
{"journey":{"revision":7,"stage":"AT_STOP","matched":true,"pending_exit":true,"reason":"left_stop","guidance":{"title":"Preparing to board"}}}
// ON_BOARD
{"journey":{"revision":8,"stage":"ON_BOARD","matched":true,"completed":true,"seat":"S02","boarding_target":{"type":"SEAT","id":"S02"},"reason":"boarding_preview",
 "animation":{"id":"app-booking-E7C1…:boarding","phase":"boarding","aid":"cane","started_at":1791014607145,"duration_ms":16000,"target":{"type":"SEAT","id":"S02"}},
 "guidance":{"title":"Follow guidance to seat S02","display_text":"From the entrance, face into the bus. Continue straight for 0.9 metres. Turn right. … Arrive at seat S02 and wait for the safety operator."}},
 "navigation":{"phase":"TO_SEAT","destination":{"type":"SEAT","id":"S02"},
  "steps":[{"step":1,"maneuver":"START","distance_m":null,"text":"From the entrance, face into the bus."},{"step":2,"maneuver":"STRAIGHT","distance_m":0.9,"text":"Continue straight for 0.9 metres."},…]}}
// 轮椅预约的 ON_BOARD：seat/boarding_target 为 WHEELCHAIR_BAY，title "Follow the wheelchair-space guidance"，navigation.phase "TO_WHEELCHAIR_BAY"，aid "wheelchair"
// 取消后
{"journey":{"journey_id":"app-cancel-5A65…","stage":"IDLE","reason":"cancelled","boarding_target":null,"guidance":{"title":"Booking cancelled"}},"navigation":null}
```

动画 id 中的 `legacy` 表示该感知没有带 `zone.visit_id`。带上以后，这一段会换成访问编号。

## 6. 联调怎么接（改动前、旧录像 venue_live_172729；现行步骤见第 7 节）

集成方在另一台 Mac 上运行 `LAN=1 bash start_demo.sh demos/captures/venue_live_172729`，终端会打印
`hub http://<IP>:8787` 和 `Access token`。手机连同一个 Wi-Fi，进入 **Settings → BusTech signal hub**：启用，选 HTTP，
填入 IP、端口 8787 和 token（token 只存在内存里，App 重启后要重新输入）。可以先用手机 Safari 打开 `http://<IP>:8787/api/health`，
看到 `ok:true` 即可。然后用 **Assistant → Demo Booking**（保持 `DEMO_ROUTE/DEMO_STOP`，文案会和 dashboard 一致）预约 Wheelchair。

回放在中枢进入 BOOKED 后才开始播放，每一轮会重新等待预约。下面的时间相对于预约（约有 0.5 s 轮询误差）：

| 时间 | 回放事件 | 中枢 journey（轮椅预约） | 改好后手机应显示 | 已提交的 App 实际显示 |
|---|---|---|---|---|
| 0 s | — | BOOKED，"Go to the bus stop"（rules 模式立刻生成；LLM 模式需几秒） | 第 1 轮 | "Request received by bus" + 站牌 |
| 8.5 s | 婴儿车进入 | AT_STOP，matched:false，"Please wait at the stop" | 不匹配，请等安全员 | **"The bus is here"** + 方案文本 |
| 14.6 s | 婴儿车离开 | 回到 BOOKED | 回到第 1 轮 | **"Please board the bus"**（锁定，之后不再变化） |
| 63.5–72 s | 婴儿车再次进出 | 同上 | 同上 | 不变 |
| 80.5 s | 轮椅进入 | AT_STOP，matched:true，arrival 动画，"Bus arriving" | 第 2 轮 + 进站动画 | 不变 |
| 84.7 s | — | "Preparing to board" | 更新文案 | 不变 |
| 89.5 s | 轮椅离开 | pending_exit:true | 继续"Preparing to board" | 不变 |
| ≈90.5 s | — | ON_BOARD，WHEELCHAIR_BAY，boarding 动画 16 s，7 步导航 | 第 3 轮：轮椅位、动画、分步导航 | 不变 |
| 91–104 s | 手杖乘客进出 | 已 completed，不再受影响 | 不变 | 不变 |

如果预约 CANE，前面的婴儿车和轮椅都会被判为不匹配；手杖在 91.1 s 进入，停留约 12.7 s，所以能看到
`navigation.phase:"BOARD_BUS"`（"Ready to board"，101 s 左右），103.8 s 离开后立即进入 ON_BOARD。

**常见坑**

- **规划模式**：中枢默认是 `single`（LLM）。如果集成机没有配置 `DEEPSEEK_API_KEY`，结果会降级为 `NEEDS_CONFIRMATION`
  （`agent.mjs` safe_fallback）：没有座位，也不会进入 ON_BOARD。请在 dashboard 里选 **Offline rules**，或者配置 key。
- **5 分钟 TTL**：从手机的 `observed_at` 开始计时。轮椅在约 80 s 出现，时间够用，但预约后不要等太久再让回放开始。重复测试时要重新预约，
  回放会等到下一次 BOOKED。
- **时钟**：手机时间比集成机快 5 s 以上，预约会被拒（`INVALID_OBSERVED_AT`）；两台设备都打开自动对时。
- **ATS / HTTP**：`Config/Info.plist` 已有 `NSAllowsLocalNetworking` 和本地网络权限说明。首次连接时必须在系统弹窗中允许
  "本地网络"，否则请求会静默失败。
- **ALLOWED_ORIGINS / CORS 与原生 App 无关**：URLSession 不发 `Origin`，`server.mjs:14` 只拦截带 Origin 的请求。401 一定是 token 错了。
- **单预约**：dashboard 的预设场景或其他人的预约会替换手机的预约（`journey.journey_id` 改变），联调时不要点 dashboard 预设。
- SSE 每 15 s 发一次 `: keep-alive` 注释行，App 的 60 s 请求超时足够；断线后 App 每秒轮询 `/api/state`，也会补上状态。
- 文案目前只有英文；App 选 zh-CN 时，中枢仍返回英文 guidance。

## 7. 第一次在真机上运行

给仓库负责人（不是 App 原作者）。手机和 Mac 连同一个 Wi‑Fi。

1. **装 Xcode**（App Store，含 iOS 18+ SDK），打开一次让它装完组件；终端运行 `sudo xcode-select -s /Applications/Xcode.app`。
2. **打开工程**：双击 `app/BusPulse SG.xcodeproj`。工程用"文件夹同步"，新文件自动包含，不用手动添加。
   如果提示缺 `Config/Secrets.xcconfig`，按 `app/README.md` 从示例复制一份（LTA key 可留空，会用模拟数据）。
3. **签名**：左侧选工程 → TARGETS 里的 `BusPulse SG` → Signing & Capabilities：勾 Automatically manage signing，
   Team 选你自己的 Apple ID（没有就在 Xcode → Settings → Accounts 里登录），Bundle Identifier 改成你自己的，如
   `com.<你的名字>.buspulse`（原来的 ID 属于原作者，不改会报错）。测试 target 若报签名错误，同样改 Team。
4. **装到手机**：手机用线连 Mac，信任电脑；iPhone 打开 设置 → 隐私与安全性 → 开发者模式；Xcode 顶部选你的手机，按 ⌘R。
   第一次启动要在手机 设置 → 通用 → VPN与设备管理 里信任你的开发者证书。
5. **Mac 上启动演示**：`LAN=1 bash start_demo.sh demos/captures/venue`。终端打印 `hub http://<IP>:8787` 和 `Access token`。
   先确认 `dashboard/next.config.ts` 已加 `allowedDevOrigins`（见上文"LAN 阻塞点"），否则手机上的孪生动画不会动（文字流程不受影响）。
   dashboard 生成模式选 **Offline rules**，或配好 `DEEPSEEK_API_KEY`。
6. **手机上填中枢**：App → Settings → BusTech signal hub：打开开关，选 HTTP，填 IP、端口 `8787`、Bridge token（只存在内存，App 重启后要重填）。
   第一次连接时系统会问"本地网络"权限，选允许。可先用手机 Safari 打开 `http://<IP>:8787/api/health` 看到 `ok:true`。
   孪生页地址由 App 自动生成：`http://<同一 IP>:3000/passenger-twin#token=<token>`（端口固定 3000）。
7. **预约**：Assistant → Demo Booking，需求选 Wheelchair、Stroller、Cane 或 Crutches（回放只有轮椅/婴儿车/手杖三段，Walker 会被判不匹配），发送。

手机上应看到（时间相对于预约）：

| 时间 | 中枢 | 手机 |
|---|---|---|
| 0 s | BOOKED | 进度第 1 步 "Request received"；标题 "Go to the bus stop"（LLM 模式先显示 "Booking received"）；站牌；"Reserved for you: Wheelchair bay / Seat Sxx" |
| ≈5 s | 信号 1：AT_STOP，matched | 第 2 步 "At the stop"；"Bus arriving" → 约 4 s 后 "Preparing to board"；下方出现公交孪生动画；触感 + 播报/VoiceOver 通告 |
| 中途 | 信号 2：pending_exit | 文案不变（不提前说上车） |
| ≈15 s | ON_BOARD | 第 3 步 "On board"；大字 "Wheelchair bay" 或 "Seat Sxx"；孪生播放上车动画；下方 "Step by step" 编号步骤；按钮变为 Done |

不匹配时（例如 dashboard 上换了别的预约或回放的辅具与预约不符）会显示 "Please wait at the stop" 和黄色提示，人离开后回到第 1 轮。
点 Cancel Request 后显示 "Booking cancelled"。孪生页加载失败时只显示一行"The live bus view is unavailable"，文字流程照常。
