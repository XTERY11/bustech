# App 模块下发说明（PROMPT-APP.md）

状态：2026-10-03 · 给 App 负责人 · 背景和接口见 [HANDOFF-APP.md](HANDOFF-APP.md)，现场流程见 [RUNBOOK.md](RUNBOOK.md)

## 这份文档是什么

`app/` 里的 iOS 代码已经按需求改完，但改代码的机器没有 Xcode，**从来没有编译过**。你的任务只有三件：编译通过、在真机上跑通、把结果发回。不需要新增功能。

下面第 2 节是一段可以直接粘贴给编程助手（Codex、Claude Code 等）的 prompt；第 3 节是你自己要做的验收；第 4 节是发回给我们的内容。

---

## 1. App 现在应该是什么样

一部手机依次扮演不同类别的乘客，一次一位：

1. 选类别（Wheelchair / Stroller / Cane 等）→ 提交预约。
2. 第一轮：三步进度条在第 1 步，显示中枢给的指引（"Go to the bus stop"）和预留的位置。
3. 第二轮（摄像头看到对应辅具进站）：第 2 步，"Bus arriving" → "Preparing to board" → "Ready to board"，下方出现公交孪生动画（网页视图）。类别不一致时是黄色的 "Please wait at the stop"。
4. 第三轮（乘客朝车离开站台区域）：第 3 步，大字显示 "Wheelchair bay" 或 "Seat S03"，孪生播放上车动画，下面是编号的车内分段导航。
5. 分段导航正下方有一个 **Finish** 按钮：点一下，手机回到选类别界面，同时通知中枢结束这次旅程，可以马上预约下一个类别。中枢连不上时也照样回到选类别界面。

所有文字来自中枢（`journey.guidance`），App 不自己编文案。阶段由中枢的 `journey.stage` 决定，App 不自己推断。

---

## 2. 给编程助手的 prompt（整段复制）

```text
你在 bustech 仓库的 app/ 目录工作，这是一个原生 iOS App（SwiftUI，Swift 6，工程 app/BusPulse SG.xcodeproj，使用文件夹同步分组，新文件自动加入）。

背景：app/BusPulse SG/Core/Assistance/ 和 app/BusPulse SG/Features/Assistance/ 下的代码最近在一台没有 Xcode 的机器上修改过，只做过 macOS 上的类型检查和部分单元测试，从未在 iOS 上编译。先读 HANDOFF-APP.md（仓库根目录）和 app/docs/hub-v05-gap.md，了解 App 应有的行为和与信号中枢的接口。

任务，按顺序做：
1. 用 Xcode 命令行编译 App 的 Debug 版本（iOS 模拟器即可）。逐个修复编译错误。只做让它编译通过所需的最小改动：不要改变行为，不要重构，不要改接口字段名，不要改界面文案。
   最可能出错的位置：
   - Features/Assistance/PassengerTwinView.swift（WKWebView 包装，只按 AppKit 的写法检查过：makeUIView / dismantleUIView、scrollView、isOpaque、backgroundColor、allowsInlineMediaPlayback、decidePolicyFor navigationResponse 的 async 写法）
   - Features/Assistance/AssistanceStatusView.swift（@ViewBuilder 里带逗号条件的 if、case .booked?, .idle?, nil 这类模式匹配、(onNextPassenger ?? onEdit)() 的可选闭包调用）
   - Core/Assistance/HTTPVehicleCloudService.swift（catch ServiceError.rejected(let status, let code) where …）
   - Core/Assistance/AssistanceRequestService.swift（@discardableResult 返回 Task<Void, Never>? 的 finish）
   - SF Symbols 名称写错不会报错，只会显示空白：figure.roll、chair.fill、door.left.hand.open、hourglass、person.2.fill、checkmark.circle.fill。运行后检查图标是否显示，不显示就换成存在的名称。
2. 运行单元测试 target 里的 HubBookingTests，全部通过。失败时先判断是测试写错还是实现写错，按 HANDOFF-APP.md 第 4 节的接口约定修正，并说明改了什么。
3. 运行 UI 测试 SignalTwoUITests（它依赖本地假中枢 app/scripts/boarding_ui_fixture.py，用法见 app/README.md）。
4. 不要修改 app/ 以外的任何文件。不要把密钥、token、个人签名团队 ID 写进提交。
5. 完成后输出：改过的文件和每处改动的原因、编译和测试的最终结果、仍然失败或没有验证的项目。
```

---

## 3. 真机验收（你自己做）

准备：把签名团队和 Bundle Identifier 换成自己的，装到 iPhone（步骤见 `app/docs/hub-v05-gap.md` 第 7 节）。

在电脑上启动演示（不需要摄像头，回放现场录像）：

```bash
LAN=1 bash start_demo.sh demos/captures/venue
```

终端会打印电脑的 IP 和 token。手机和电脑连同一个网络，在 App 的 Settings → BusTech signal hub 里打开开关，选 HTTP，填 IP、端口 `8787` 和 token。没有 DeepSeek key 时，在电脑浏览器打开 `http://127.0.0.1:3000`，展开右上角的控制面板，把 Generation mode 选成 Offline rules。

按下表走三轮，每轮在手机上预约后不用再操作，回放会自动发出进站和离站信号：

| 轮次 | 预约类别 | 应看到 |
|---|---|---|
| 1 | Wheelchair | 约 5 秒后第 2 步和孪生；约 15 秒后第 3 步，"Wheelchair bay"，分段导航，Finish 按钮 |
| — | 点 Finish | 回到选类别界面；电脑上的 dashboard 回到空闲 |
| 2 | Stroller | 同上，位置是一个座位编号，导航里有停放婴儿车的步骤 |
| — | 点 Finish | 回到选类别界面 |
| 3 | Cane | 同上，位置是一个座位编号 |

另外检查三件事：

- 第二、三轮里公交孪生动画能显示并且会动（它是网页，地址是 `http://<IP>:3000/passenger-twin#token=<token>`）。不显示时先用手机 Safari 打开这个地址看能否加载。
- 预约后点 Cancel Request，手机显示已取消，再预约能正常开始。
- 关掉电脑上的演示后点 Finish，手机仍然回到选类别界面，不卡住。

---

## 4. 发回给我们的内容

- 编译是否通过；如果改了代码，改动以 PR 提交到 main，或者把 diff 和完整报错发回，由我们合入。**不要长期在自己的分支上继续改**，否则两边又要来回同步。
- 三轮验收里每一步手机上实际显示的内容，和上表不一致的地方（截图最好）。
- 局域网连接是否顺利：IP 是否正确、是否弹出本地网络权限、孪生页是否加载。这条链路在我们这边没有用真机测过。

---

## 5. 之后想做小修改

界面、文案、类别、收发字段各自在哪个文件，见 [HANDOFF-APP.md](HANDOFF-APP.md) 第 6 节。手机上的指引文字由中枢生成，改 `dashboard/backend/journey.mjs` 的 `guidance()`，手机和 dashboard 会同时变。
