# 真实摄像头验收说明书（RUNBOOK.md）

状态：2026-10-03 · 用于现场验收和演示 · 背景见 [HANDOFF.md](HANDOFF.md)，App 侧见 [HANDOFF-APP.md](HANDOFF-APP.md)

一页看懂：现场按什么顺序操作，每一步对应哪个信号，各块屏幕应该看到什么，哪里需要等。

---

## 1. 信号怎样流动

一次只服务一位乘客。三个模块只通过中枢交换信号。

```
 ① App 预约 ─────────────► 中枢 ──► 大模型推理一次（约 1–2 秒），定下方案和座位
 ② 摄像头：辅具进入站台区域 ─► 中枢 ──► 核对类别与预约一致（握手）──► 公交进站、开门（10 秒）
 ③ 摄像头：停留后朝车离开 ───► 中枢 ──► 上车阶段：车内引导到分配的位置
                              │
                              └──► dashboard 和手机读同一份状态，同时更新
```

| 信号 | 谁发出 | 什么时候发 | 中枢的反应 |
|---|---|---|---|
| ① 预约 | App | 乘客选好类别并提交 | 阶段 `BOOKED`；调用大模型一次 |
| ② 触发信号一（进站） | 摄像头 | 有人带着的辅具进入画好的区域并持续 0.3 秒 | 类别一致：阶段 `AT_STOP`，开始 10 秒进站动画。不一致：只提示等待，车不动 |
| 心跳 | 摄像头 | 区域里有人期间，约每 2 秒一次 | 不改变阶段 |
| ③ 触发信号二（离站） | 摄像头 | 区域里连续 2 秒没有人 | 判为上车：阶段 `ON_BOARD`。判为没有上车：回到 `BOOKED` |

"判为上车"的条件：在区域里停够 2 秒，然后朝车的方向离开（默认是往画面深处）。路过、从侧面走出、朝镜头方向离开都不算。

大模型只在预约时调用一次；②③ 到达时中枢只用本地规则核对，不再等待大模型。

---

## 2. 操作顺序

### 2.1 准备（每次换场地或挪动摄像头后做一次）

1. 电脑和拍摄用的手机连同一个网络，手机打开 DroidCam 并保持在前台，记下地址，例如 `http://172.20.10.4:4747/video`。
2. 画站台区域：
   ```bash
   cd ~/Documents/bustech && source .toolchain/env.sh
   cd vision && .venv/bin/python monitor_zone.py --source "http://172.20.10.4:4747/video"
   ```
   按 `R` 清掉旧区域 → 左键点出区域的角 → 回车保存 → 按 `Q` 退出（DroidCam 同一时间只允许一个连接，不退出后面连不上）。
3. 车在哪一侧：默认认为车在画面深处。如果现场不是这样，在 `vision/monitor_roi.json` 里加一项 `"board_direction": "left"`（可选 `up`、`down`、`left`、`right`）。
4. 先用回放确认整条链路正常，再接摄像头：
   ```bash
   cd ~/Documents/bustech && bash start_demo.sh demos/captures/venue
   ```
   打开 <http://127.0.0.1:3000>，在左侧摄像头面板下方的 **Replay full flow** 里点 Wheelchair、Stroller、Cane 中的一个：视频、触发信号、公交动画和指引会一起走完，约 15 秒进入上车阶段。三类各点一遍，都正常再接摄像头。按 `Ctrl + C` 停止。

### 2.2 启动

在同一个终端窗口里：

```bash
cd ~/Documents/bustech && source .toolchain/env.sh
read -s DEEPSEEK_API_KEY && export DEEPSEEK_API_KEY      # 粘贴 key 后回车，不显示
BRIDGE_WINDOW=1 BRIDGE_RECORD=1 bash start_demo.sh "http://172.20.10.4:4747/video"
```

- `BRIDGE_WINDOW=1`：弹出带标注的实时画面窗口。
- `BRIDGE_RECORD=1`：同时把原始画面录到 `vision/recordings/`，出问题时可以回放复查。
- 手机 App 要连进来时，在最前面加 `LAN=1`，终端会打印 IP 和 token。

### 2.3 每一轮验收（轮椅、婴儿车、手杖各一轮）

| 步骤 | 现场的人做什么 | 等多久 |
|---|---|---|
| 1 | 带辅具的人站在区域**外面**。操作员在 App 上选类别并提交预约（没有 App 时用下面的命令）。人已经在区域里时再预约也可以，预约一到就直接进入步骤 2 | 等 dashboard 出现推理结果，约 1–2 秒 |
| 2 | 带着辅具走进区域，站住 | 约 0.5 秒后画面变红，出现 `TRIGGER` |
| 3 | **在区域里等公交进站、开门、放好坡道** | **约 10 秒**，等孪生显示 "Ready to board" |
| 4 | 朝车的方向（默认往画面深处）走出区域 | 走出后约 2 秒，画面恢复绿色 |
| 5 | 看上车动画和车内指引 | 动画约 16 秒，婴儿车 22 秒 |
| 6 | 下一轮：其他人离开区域，回到步骤 1 | — |

用命令代替 App 发预约（把 `WHEELCHAIR` 换成 `STROLLER` 或 `CANE`；后两类把 `"assistance_requested"` 改成 `["ADDITIONAL_BOARDING_TIME"]`、`"ramp_preference"` 改成 `"UNSPECIFIED"`）：

```bash
curl -X POST http://127.0.0.1:8787/api/booking -H 'Content-Type: application/json' \
  -d '{"event_id":"app-'$(date +%s)'","observed_at":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'","payload":{"active":true,"intent":"BOARDING","route_id":"DEMO_ROUTE","stop_id":"DEMO_STOP","accessibility_need":"WHEELCHAIR","ramp_preference":"REQUESTED","assistance_requested":["WHEELCHAIR_RAMP"],"preferred_interaction":"BOTH","language":"en-SG"}}'
```

### 2.4 手机 App 连进来

1. 启动命令最前面加 `LAN=1`，例如 `LAN=1 BRIDGE_WINDOW=1 bash start_demo.sh "http://172.20.10.4:4747/video"`（回放自检时是 `LAN=1 bash start_demo.sh demos/captures/venue`）。终端会打印两行：
   ```
   LAN mode: dashboard http://<IP>:3000  hub http://<IP>:8787  camera http://<IP>:8790
   Access token (App / dashboard Connection settings): <token>
   ```
2. 手机和电脑连同一个网络。在 App 的 Settings → BusTech signal hub 里打开开关，选 HTTP，填 `<IP>`、端口 `8787` 和 `<token>`。第一次连接时允许"本地网络"权限。
3. 可以先在手机 Safari 打开 `http://<IP>:8787/api/health`，看到 `"ok":true` 说明网络是通的。
4. 之后步骤 1 的预约就在 App 里提交，手机上应看到的内容见第 3 节"手机 App"一栏。

注意：

- token 每次启动演示都会换，App 重启后也要重新填。
- 打印的 IP 取自电脑的 en0 网卡。连手机热点时如果 IP 是空的或不对，用 `ipconfig getifaddr en0`（或 en1）核对。
- 用命令代替 App 发预约时，LAN 模式下要加 `-H 'Authorization: Bearer <token>'`。
- **多部手机**：可以同时连接（都填同一个 IP 和 token），但中枢同一时间只有一个预约。一部手机上车完成后，另一部再预约，可以连续演示；如果第二部手机在第一部走完之前预约，第一部的旅程会被替换。

---

## 3. 每一步各块屏幕应该看到什么

时间以回放实测为参考，从预约算起；真实摄像头下步骤 2–4 的时刻取决于人怎么走。

| 时刻 | 发生了什么 | 摄像头画面 | dashboard | 公交孪生 | 手机 App |
|---|---|---|---|---|---|
| 0 秒 | ① 预约到达 | 绿色区域，`MONITORING` | 通道条：预约类别、"Booked" | 待命 | 第 1 步 "Request received" |
| 约 1–2 秒 | 大模型返回 | 不变 | Thinking 面板逐词显示推理摘要；生成来源 "DeepSeek response" 和耗时 | "Request received" | "Go to the bus stop"；预留的位置 |
| 人进区域后约 0.5 秒 | ② 触发信号一，类别一致 | 区域变红，`TRIGGER wheelchair` | 旅程 "At The Stop"；指引 "Bus arriving" | 公交驶入站台（约 4 秒） | 第 2 步 "At the stop"；"Bus arriving"；出现孪生 |
| 进站后约 4–10 秒 | 车辆准备 | 保持红色 | 指引 "Preparing to board" | 下蹲、开门、按方案伸坡道 | "Preparing to board" |
| 进站后 10 秒 | 准备完成 | 保持红色 | 指引 "Ready to board" | 门开、坡道就位 | "Ready to board" |
| 人走出区域后约 2 秒 | ③ 触发信号二，判为上车 | 恢复绿色，`MONITORING` | 旅程 "On Board"；显示分配的位置和车内分段指引 | 切到车厢视角，乘客沿路线走到位置（约 16 秒） | 第 3 步 "On board"；大字位置；分段步骤；按钮变 Done |

异常情况下应该看到的：

| 情况 | 摄像头画面 | dashboard 和孪生 | 手机 |
|---|---|---|---|
| 进站的辅具与预约类别不一致 | 照常变红 | 旅程 "At The Stop · Unmatched"；车不动、不开门 | "Please wait at the stop"，黄色提示 |
| 没有预约就有人进站 | 照常变红 | 没有旅程变化 | — |
| 路过，或从侧面、朝镜头方向离开 | 恢复绿色 | 回到 "Booked"，等乘客再次进站 | 回到第 1 步 |
| 进站不到 10 秒就朝车离开 | 恢复绿色 | 进站动画先播完，到第 10 秒再进入上车阶段 | 同左，晚几秒更新 |

---

## 4. 哪里有等待

| 等待 | 多久 | 为什么 | 现场怎么配合 |
|---|---|---|---|
| 大模型响应 | 约 1–2 秒 | 预约时调用一次 DeepSeek | 提交预约后停一两秒再让人进区域，演示时正好讲解推理 |
| 进站确认 | 0.3 秒 | 防止检测框抖动造成误触发 | 走进区域后站稳 |
| 公交进站和车辆准备 | 固定 10 秒 | 模拟公交驶入、下蹲、开门、伸坡道 | **在区域里等满 10 秒再走**，否则孪生比人慢 |
| 最短停留 | 2 秒 | 区分"等车后上车"和"路过" | 不要一进就出 |
| 离站确认 | 2 秒 | 区域里连续 2 秒没有人才算离开 | 人走出后，**其他人不要站在区域里**，否则一直不算离开 |
| 心跳中断 | 8 秒 | 区域里有人时检测桥约每 2 秒报一次；中枢 8 秒没收到这次进站的消息，就当人已离开 | 已显示 "Ready to board"：直接进入上车阶段；还没到：回到 "Booked"，等乘客再进站 |
| 上车动画 | 约 16 秒，婴儿车 22 秒 | 车内引导 | 不必等播完：下一位的预约一到，就换成新的旅程和新的模拟公交 |
| 预约有效期 | 5 分钟，从预约时刻算 | 过期后预约作废 | 预约后 5 分钟内进站，否则重新预约。进站且类别一致后暂停计时；之后又回到 "Booked" 时若已超过 5 分钟，预约立即作废 |

一轮顺利的话：预约 → 约 2 秒后进站 → 等 10 秒 → 离开 → 约 2 秒后进入上车阶段 → 16 秒动画，合计约半分钟。

---

### 现场要避免的五件事

- 朝车走出区域后又走回来，等于取消离站：要再朝车走出一次才进入上车阶段（不会自己上车，也不会卡住）。
- 有人在区域里时不要停止或重启检测桥：8 秒后中枢当人已离开（已 "Ready to board" 的直接上车，否则回到 "Booked"），与现场不符。
- 同一个中枢只接一个检测桥：接真实摄像头前先停掉回放。
- 中枢重启后，预约要重新发。
- 上一位乘客离开区域后再发下一位的预约：留在区域里的人若带着同类辅具（如连续两位轮椅），会被当成下一位已到站；不同类辅具只显示 "Unmatched" 等待。

接摄像头前可以先跑一遍不需要摄像头的握手自检（15 种情况，含轮椅→婴儿车→手杖→轮椅连续四轮，约 4 分钟，需要另开一个空闲端口的中枢，不要对着正在演示的中枢跑）：

```bash
cd dashboard && BRIDGE_PORT=8887 node backend/server.mjs          # 终端一
cd vision && .venv/bin/python rehearse_live.py --bridge-url http://127.0.0.1:8887   # 终端二
```

---

## 5. 出问题时先看哪里

| 现象 | 先检查 |
|---|---|
| 没有视频，终端报 `Connection refused` | DroidCam 不在前台或已锁屏；画区域的窗口没有按 `Q` 退出 |
| 人在区域里但画面不变红 | 区域画得太小或贴着画面下沿；辅具没有"被人带着"（停着的辅具旁边站人不算）；辅具被画面边缘切掉 |
| 变红了但旅程停在 "Booked" | 类别与预约不一致；预约已过期；没有预约 |
| 走出区域后不进入上车阶段 | 区域里还有别人；离开方向不是朝车一侧；停留不到 2 秒；进站还不满 10 秒（等一下） |
| dashboard 显示 key 未配置 | `read -s` 和启动命令不在同一个终端窗口 |
| 触发了但中枢完全没反应 | `curl http://127.0.0.1:8790/health`：`pending_signals` 和 `dropped_signals` 应为 0，`signal_error` 应为 null。检测桥和中枢不在同一台电脑时看 `hub_clock_offset_s`，检测桥的时钟比中枢快 5 秒以上，信号会被全部丢弃 |
| 想复查刚才发生了什么 | `vision/trigger_snapshots/` 里每次触发、类别变化、离开都有截图和 `events.jsonl`；`curl http://127.0.0.1:8787/api/state` 看 `journey` |
