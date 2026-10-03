# 真实摄像头测试说明书（RUNBOOK.md）

状态：2026-10-03 · 用于实时摄像头的搭建、测试和演示 · 背景见 [HANDOFF.md](HANDOFF.md)，App 侧见 [HANDOFF-APP.md](HANDOFF-APP.md)

照着做就能搭起来：需要什么设备，每一步敲什么命令，每个信号由什么触发，每一步在各块屏幕上应该看到什么，哪里要等。

---

## 1. 这次测试用到什么

| 设备 | 角色 | 上面运行什么 |
|---|---|---|
| 电脑（Mac） | 核心：识别、中枢、dashboard | 检测桥（读摄像头、发触发信号）、信号中枢（端口 8787）、dashboard 网页（端口 3000） |
| 手机 A | 摄像头 | DroidCam，把画面通过网络传给电脑 |
| 手机 B | 乘客的手机 | BusPulse App：选类别、预约、看指引 |
| 一件辅具 | 被识别的对象 | 手杖、轮椅或婴儿车。小场地先用手杖 |

三台设备连**同一个网络**。校园或公司 Wi‑Fi 常常不允许设备互相访问，连不上时改用手机热点（两部手机和电脑都连到同一个热点）。

一次只测一位乘客：手机 B 预约一个类别 → 拿着对应辅具的人走一遍 → 结束 → 再预约下一个类别。

---

## 2. 触发逻辑

三个模块只通过中枢交换信号，互相不直接通信。

```
 ① 手机 B 预约 ───────────► 中枢 ──► 大模型推理一次（约 1–2 秒），定下方案和座位
 ② 摄像头：辅具进入站台区域 ─► 中枢 ──► 核对类别与预约一致 ──► 公交进站、开门（10 秒）
 ③ 摄像头：停留后朝车离开 ───► 中枢 ──► 上车阶段：车内引导到分配的位置
                              │
                              └──► dashboard 和手机 B 读同一份状态，同时更新
```

| 信号 | 谁发出 | 触发条件 | 中枢的反应 |
|---|---|---|---|
| ① 预约 | 手机 B | 乘客选好类别并提交 | 阶段变为"已预约"；调用大模型一次 |
| ② 触发信号一（进站） | 摄像头 | 有人带着的辅具进入画好的区域，持续 0.3 秒 | 类别与预约一致：阶段变为"到站"，开始 10 秒进站动画。不一致：只提示等待，车不动 |
| 心跳 | 摄像头 | 区域里有人期间，约每 2 秒一次 | 不改变阶段，只表示人还在 |
| ③ 触发信号二（离站） | 摄像头 | 区域里连续 2 秒没有人 | 判为上车：阶段变为"已上车"。判为没有上车：回到"已预约" |

- **什么算"有人带着的辅具"**：手杖要被人握着；轮椅要有人坐着或推着；婴儿车要有人推着。停在一边的辅具不算。
- **什么算"上车"**：在区域里停够 2 秒，然后朝车的方向走出区域。车的方向默认是画面深处（离镜头远的一侧）。路过、从侧面走出、朝镜头方向走出都不算上车。
- 大模型只在预约时调用一次。②③ 到达时中枢只用本地规则核对，不等大模型。

---

## 3. 搭建步骤

所有命令在电脑的终端里执行。先进入项目并加载工具链：

```bash
cd ~/Documents/bustech && source .toolchain/env.sh
```

### 第 1 步：先用回放确认软件没问题（不需要手机）

```bash
bash start_demo.sh demos/captures/venue
```

打开 <http://127.0.0.1:3000>。左侧摄像头面板下方有 **Replay full flow**，点 Cane：现场录像、两个触发信号、公交动画和指引会一起走完，约 15 秒进入上车阶段。点右侧指引栏里的 **Reset** 清屏。正常后按 `Ctrl + C` 停掉。

同一个中枢只能接一个检测桥，接真实摄像头前必须先停掉回放。

### 第 2 步：架好手机 A（摄像头）

1. 手机 A 打开 DroidCam，保持在前台、不锁屏。记下它显示的地址，例如 `http://172.20.10.4:4747/video`。
2. 固定机位：能看到地面上的一块"站台区域"，以及区域后面乘客走向"车"的方向。之后不要再动手机，动了要重画区域。

### 第 3 步：画站台区域，并说明车在哪一侧

每个场地存成一个"场景"，包含画好的区域和车所在的一侧。已有两个场景：

| 场景 | 用途 | 车在哪一侧 |
|---|---|---|
| `classroom` | 演示和调试用的小教室，摄像头放在桌上 | `down`：乘客等完后朝镜头方向走出画面 |
| `venue` | 最终验收场地（10 月 2 日的布置） | `up`：乘客往画面深处走；到现场后要重画区域 |

机位没动、区域不用变时，这一步可以跳过。要重画或新建场景：

```bash
bash vision/draw_region.sh classroom "http://172.20.10.4:4747/video" down
```

三个参数依次是场景名、摄像头地址、车在哪一侧（`up` 画面深处，`down` 朝镜头，`left`，`right`）。在弹出的窗口里：按 `R` 清掉旧区域 → 鼠标左键依次点出区域的四个角 → 按回车保存 → 按 `Q` 退出。

- **车在哪一侧必须设对。**乘客等完之后朝哪边走出区域去"上车"，就填哪一侧。朝其他方向离开会被判为"没有上车"，流程退回"已预约"；方向设反时，往回走反而会被当成上车。
- 区域画在地面上，大小够一个人带着辅具站进去。
- 一定要按 `Q` 退出。DroidCam 同一时间只允许一个连接，不退出下一步连不上。

### 第 4 步：启动（实时摄像头 + 大模型 + 允许手机连接）

最快的方式是一条命令（场景默认 `classroom`，摄像头地址只在第一次或变化时给）：

```bash
bash live.sh 172.20.10.4          # 之后直接 bash live.sh
```

它会依次：检查端口 → 需要时询问 DeepSeek key（不显示、不保存；直接回车就用规则模式）→ 等摄像头可达 → 打印手机 B 要填的主机和端口 → 启动并自动打开 dashboard。换场景：`SCENE=venue bash live.sh <地址>`。

下面是它展开后的等价命令，需要单独调整参数时使用。

在**同一个终端窗口**里：

```bash
read -s DEEPSEEK_API_KEY && export DEEPSEEK_API_KEY
SCENE=classroom LAN=1 BRIDGE_WINDOW=1 BRIDGE_RECORD=1 bash start_demo.sh "http://172.20.10.4:4747/video"
```

- `SCENE=classroom`：用哪个场景的区域和车的方向。验收场地换成 `SCENE=venue`。
- 第一行：粘贴 DeepSeek 的 key 后回车，输入不显示。没有 key 就跳过这一行，稍后在 dashboard 右上角展开控制面板，把 Generation mode 选成 Offline rules。
- `LAN=1`：让手机 B 能连进来。终端会打印两行，记下 IP 和 token：
  ```
  LAN mode: dashboard http://<IP>:3000  hub http://<IP>:8787  camera http://<IP>:8790
  Access token (App / dashboard Connection settings): <token>
  ```
- `BRIDGE_WINDOW=1`：电脑上弹出带标注的实时画面窗口。
- `BRIDGE_RECORD=1`：同时把原始画面录到 `vision/recordings/`，出问题时可以回放复查。
- macOS 第一次可能弹出"是否允许接受传入网络连接"，选允许。

打印的 IP 取自电脑的 en0 网卡。IP 是空的或不对时，用 `ipconfig getifaddr en0`（或 `en1`）核对。同一台电脑上 token 每次启动都相同，手机 B 填一次即可；电脑的 IP 变了才需要改主机地址。

手机 A 的 DroidCam 断开（切到后台、锁屏）时，检测桥每 2 秒自动重连，演示不会停。

### 第 5 步：dashboard

启动后 dashboard 会自动在浏览器里打开并连上中枢（地址里带着 token，浏览器会记住它）。**只留一个标签页。**应看到：右上角 "Signal server connected"；左侧是手机 A 的实时画面和绿色区域；右侧是关着门的公交；上方 Thinking 面板显示 "Ready"。

如果右上角是 "Signal server disconnected"：刷新页面；仍然不行时，打开终端里打印的 "Dashboard with token" 那一行地址。

大模型的推理显示在最上面的 Thinking 面板：预约后约 1–5 秒出现推理摘要、生成来源（DeepSeek response）和耗时。

### 第 6 步：手机 B 连上中枢

1. 可以先用手机 B 的 Safari 打开 `http://<IP>:8787/api/health`，看到 `"ok":true` 说明网络是通的。
2. 打开 App → Settings → BusTech signal hub：打开开关，选 HTTP，填 `<IP>`、端口 `8787`、`<token>`。
3. 第一次连接时系统会问"本地网络"权限，选允许。

App 重启后 token 要重新填（token 本身不变）。

### 第 7 步：检查一遍再开始

| 检查 | 应该是 |
|---|---|
| 电脑上的实时画面窗口和 dashboard 左侧 | 都有画面，区域是绿色，左上角 `MONITORING` |
| 一个人不拿辅具走进区域 | 人被灰色细框标出，区域**不**变红 |
| `curl http://127.0.0.1:8790/health` | `pending_signals` 和 `dropped_signals` 是 0，`signal_error` 是 null |
| dashboard 通道条 | Signal hub: Connected |

---

## 4. 走一轮（以手杖为例）

| 步骤 | 现场的人做什么 | 等多久 |
|---|---|---|
| 1 | 拿手杖的人站在区域**外面**。在手机 B 上选 Cane 并提交预约 | 等 dashboard 出现推理结果，约 1–2 秒 |
| 2 | 握着手杖走进区域，站住，手杖杵在地上、不要被身体完全挡住 | 约 0.5 秒后区域变红，出现 `TRIGGER cane` |
| 3 | **在区域里等公交进站、开门**。看 dashboard 指引栏里的倒计时 "Bus ready in Ns" | **10 秒**，倒计时归零变成绿色的 "Ready to board · GO" 再走 |
| 4 | 朝车的方向（默认往画面深处）走出区域 | 走出后约 2 秒，区域恢复绿色 |
| 5 | 看上车动画和车内指引 | 动画约 16 秒（婴儿车 22 秒） |
| 6 | 结束这一轮，见第 6 节 | — |

人已经站在区域里时再预约也可以，预约一到就直接进入步骤 3。

没有手机 B 时，用命令代替它发预约（LAN 模式下要带 token）：

```bash
curl -X POST http://127.0.0.1:8787/api/booking -H 'Content-Type: application/json' -H 'Authorization: Bearer <token>' \
  -d '{"event_id":"app-'$(date +%s)'","observed_at":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'","payload":{"active":true,"intent":"BOARDING","route_id":"DEMO_ROUTE","stop_id":"DEMO_STOP","accessibility_need":"CANE","ramp_preference":"UNSPECIFIED","assistance_requested":["ADDITIONAL_BOARDING_TIME"],"preferred_interaction":"BOTH","language":"en-SG"}}'
```

换类别：`CANE` 改成 `STROLLER` 或 `WHEELCHAIR`；轮椅另外把 `"ramp_preference"` 改成 `"REQUESTED"`、`"assistance_requested"` 改成 `["WHEELCHAIR_RAMP"]`。

---

## 5. 每一步各块屏幕应该看到什么

| 时刻 | 发生了什么 | 摄像头画面（电脑窗口和 dashboard 左侧） | dashboard | 公交孪生（dashboard 右侧） | 手机 B |
|---|---|---|---|---|---|
| 预约提交 | ① 预约到达 | 绿色区域，`MONITORING` | 通道条：App booking 显示类别，Journey 显示 "Booked" | 待命，门关着 | 进度第 1 步 "Request received" |
| 约 1–2 秒后 | 大模型返回 | 不变 | Thinking 面板逐词显示推理摘要；生成来源 "DeepSeek response" 和耗时；指引 "Go to the boarding point" | "Request received" | "Go to the bus stop"；为你预留的座位 |
| 人进区域约 0.5 秒后 | ② 触发信号一，类别一致 | 区域变红，`TRIGGER cane`，手杖被橙色框标出 | Journey "At The Stop"；指引 "Bus arriving" | 公交驶入站台（约 4 秒） | 第 2 步 "At the stop"；"Bus arriving"；出现公交动画 |
| 进站后 4–10 秒 | 车辆准备 | 保持红色 | 指引 "Preparing to board" | 开门（轮椅还会下蹲、伸坡道） | "Preparing to board" |
| 进站后 10 秒 | 准备完成 | 保持红色 | 指引 "Ready to board" | 门开着，等乘客 | "Ready to board" |
| 人走出区域约 2 秒后 | ③ 触发信号二，判为上车 | 恢复绿色，`MONITORING` | Journey "On Board"；显示分配的座位和车内分段指引 | 切到车厢视角，乘客沿路线走到座位 | 第 3 步 "On board"；大字座位号；分段步骤；下方出现 **Finish** 按钮 |

不按预期走时应该看到的：

| 情况 | 摄像头画面 | dashboard 和孪生 | 手机 B |
|---|---|---|---|
| 进站的辅具与预约类别不一致 | 照常变红 | Journey "At The Stop · Unmatched"；车不动、不开门 | 黄色提示 "Please wait at the stop" |
| 没有预约就有人带辅具进站 | 照常变红 | 没有旅程变化 | — |
| 路过，或从侧面、朝镜头方向走出 | 恢复绿色 | 回到 "Booked"，等乘客再次进站 | 回到第 1 步 |
| 进站不到 10 秒就朝车走出 | 恢复绿色 | 进站动画先播完，到第 10 秒再进入上车阶段 | 同左，晚几秒更新 |
| 朝车走出后又走回区域 | 再次变红 | 取消这次离站，继续等待 | 仍在第 2 步 |

---

## 6. 结束一轮，开始下一轮

手机和 dashboard 各管各的，互不影响：

| 操作 | 效果 |
|---|---|
| 手机 B 点导航下方的 **Finish** | 手机回到选类别界面，可以预约下一个类别。dashboard 不变，继续显示上车动画和结果 |
| dashboard 指引栏右侧点 **Reset** | dashboard 清屏：回到 "No active booking"，公交回到空车关门状态。任何阶段都可以点，用来清掉当前这一轮 |
| 不点任何按钮，手机 B 直接预约下一个类别 | 上一位已上车的话，新预约立刻开始，dashboard 自动切到新的旅程 |

每一轮都是一辆新的模拟公交，座位和轮椅位都空着。

建议的节奏：乘客上车 → 讲解完 dashboard 上的结果 → 操作员点 Reset → 手机 B 点 Finish → 上一位的人离开区域 → 预约下一个类别。

---

## 7. 哪里有等待

| 等待 | 多久 | 为什么 | 现场怎么配合 |
|---|---|---|---|
| 大模型响应 | 约 1–2 秒 | 预约时调用一次 DeepSeek | 提交预约后停一两秒再进区域 |
| 进站确认 | 0.3 秒 | 防止检测框抖动造成误触发 | 走进区域后站稳 |
| 公交进站和车辆准备 | 固定 10 秒 | 模拟公交驶入、开门、伸坡道。动画铺满这 10 秒，最后一个动作（开门或坡道伸出）结束时正好归零 | **等 dashboard 上的倒计时归零（绿色 GO）再走**。提前走不会卡住：倒计时变成橙色 "Left the stop · boarding starts in Ns"，归零后自动进入上车阶段 |
| 最短停留 | 2 秒 | 区分"等车后上车"和"路过" | 不要一进就出 |
| 离站确认 | 2 秒 | 区域里连续 2 秒没有人才算离开 | 人走出后，**其他人不要站在区域里** |
| 心跳中断 | 8 秒 | 中枢 8 秒没收到这次进站的心跳，就当人已离开 | 已显示 "Ready to board" 的直接算上车；否则回到 "Booked" |
| 上车动画 | 约 16 秒，婴儿车 22 秒 | 车内引导 | 不必等播完，可以直接 Reset 或预约下一位 |
| 预约有效期 | 5 分钟 | 过期后预约作废 | 预约后 5 分钟内进站。进站且类别一致后暂停计时 |

顺利的一轮：预约 → 约 2 秒后进站 → 等 10 秒 → 走出 → 约 2 秒后进入上车阶段，合计约 15 秒，加上动画约半分钟。

---

## 8. 现场要避免的事

- 有人在区域里时不要停止或重启检测桥：8 秒后中枢会当人已离开。
- 上一位的人离开区域后再发下一位的预约：留在区域里的人如果带着同类辅具，会被当成下一位已到站。
- 区域里一次只站一个人：两个人同时在区域里，摄像头要等两人都离开才报离站。
- 不要挪动手机 A；挪了要重画区域（第 3 步）。
- dashboard 只开一个标签页。
- 中枢重启后，预约要重新发，手机 B 的 token 要重新填。

---

## 9. 出问题时先看哪里

| 现象 | 先检查 |
|---|---|
| 没有视频，终端报 `Connection refused` | DroidCam 不在前台或已锁屏；画区域的窗口没有按 `Q` 退出 |
| 终端报 `Operation timed out` / `No route to host` | 电脑和手机 A 不在同一网络，或网络不允许设备互访（换热点）；macOS 未允许终端访问本地网络（系统设置 → 隐私与安全性 → 本地网络） |
| 手机 B 连不上 | Safari 打开 `http://<IP>:8787/api/health` 试；IP 是否正确；token 是否是这次启动打印的；是否允许了本地网络权限；启动命令是否带了 `LAN=1` |
| 手机 B 上公交动画不显示，文字正常 | Safari 打开 `http://<IP>:3000/passenger-twin#token=<token>` 看能否加载 |
| 人在区域里但不变红 | 辅具没被识别（手杖被身体挡住、太细太远、贴着画面边缘）；区域画得太小；辅具没有被人拿着 |
| 变红了但旅程停在 "Booked" | 类别与预约不一致；预约已过期；没有预约 |
| 走出区域后不进入上车阶段，手机退回 "Go to the bus stop" | 走出的方向不是场景里设的车的一侧（最常见，见第 3 步）；区域里还有别人；停留不到 2 秒。查 `vision/trigger_snapshots/events.jsonl` 最后一条 `CLEAR`：`why` 是 `left_another_way` 就是方向问题 |
| 往回走却播了上车动画 | 车的方向设反了，见第 3 步 |
| dashboard 不显示推理、画面不跟着变 | 右上角是不是 "Signal server disconnected"；刷新页面 |
| dashboard 显示 key 未配置 | `read -s` 和启动命令不在同一个终端窗口 |
| dashboard 显示未连接或需要 token | LAN 模式下在 Connection settings 里填 token |
| 触发了但中枢没反应 | `curl http://127.0.0.1:8790/health`：`pending_signals`、`dropped_signals` 应为 0，`signal_error` 应为 null |
| 屏幕和人的动作对不上，想看时间线 | 运行演示的终端里，每次旅程变化都有一行 `[journey 时:分:秒] …`，对照检测桥的 `TRIGGER` / `CLEAR` 行 |
| 想复查刚才发生了什么 | `vision/trigger_snapshots/` 里每次触发、类别变化、离开都有截图和 `events.jsonl`；`curl http://127.0.0.1:8787/api/state` 看 `journey`（LAN 模式加 token） |

---

## 10. 附：兜底行为和自检

- **多部手机**不是测试目标，但不会把系统弄乱：每个类别同时只接受一个预约，同类别的第二个预约被拒绝；不同类别的预约排队，一次只服务一位，谁的辅具先被摄像头看到谁先开始。
- **不需要摄像头的握手自检**（17 种情况，约 5 分钟）。另开一个空闲端口的中枢来跑，不要对着正在演示的中枢：
  ```bash
  cd dashboard && BRIDGE_PORT=8887 node backend/server.mjs          # 终端一
  curl -X POST http://127.0.0.1:8887/api/settings -H 'Content-Type: application/json' -d '{"mode":"rules"}'   # 没有 key 时先切到规则模式
  cd vision && .venv/bin/python rehearse_live.py --bridge-url http://127.0.0.1:8887   # 终端二
  ```
