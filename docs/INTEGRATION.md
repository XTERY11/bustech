# 吸收队友分支的流程（INTEGRATION.md）

状态：2026-10-03 · 面向负责合并的人 · 背景见 [HANDOFF.md](../HANDOFF.md)，现场流程见 [RUNBOOK.md](../RUNBOOK.md)

规则只有一条：**main 上已经整合好的逻辑是标准**。队友分支里的改进要并进这套逻辑里，不能反过来让 main 去迁就分支。分支和 main 冲突时，以 main 的行为为准，再把分支的改进改写到能在 main 的流程里工作。

---

## 1. 步骤

### 1.1 取回分支，看它改了什么

```bash
cd ~/Documents/bustech && source .toolchain/env.sh
git fetch --all
git log --oneline main..origin/<branch>                     # 分支独有的提交
git merge-base main origin/<branch>                         # 分支从哪一版 main 分出去
git diff $(git merge-base main origin/<branch>) origin/<branch> --stat   # 只看分支自己的改动
git diff $(git merge-base main origin/<branch>) origin/<branch> -- dashboard/backend twin/src
```

先读分支的说明（PR 描述、HANDOFF 里新增的一节），列出它新增或改变的**行为**，而不只是文件。分支分出去之后 main 上又有了什么（`git log <merge-base>..main`），也要一起列出来：这些是分支作者没见过、最容易被悄悄改回去的逻辑。

### 1.2 在本地合并，以 main 为准

```bash
git checkout -b integrate-<name> main
git merge --no-ff origin/<branch>
```

解决冲突时：

- 中枢 `dashboard/backend/{hub,journey}.mjs`、规划 `planner/*`、App 接口字段：保留 main 的流程（第 2 节），把分支新增的字段或规则加进去。
- 孪生 `twin/src` 和 `dashboard/app/lib/twinScenario.ts`：保留 main 的时序（到站 10 秒、同车后一位 3 秒、上车 16 秒），分支新增的动画放进这套时序里。
- 文档：README、RUNBOOK、HANDOFF-APP 以 main 为准；分支的新内容另写一节。
- 不冲突的文件也要看：分支可能在没有冲突的地方用旧写法覆盖了 main 的行为。按 1.1 的行为清单逐条对比合并后的代码。
- `app/`（iOS）只改文档，不改代码；App 需要知道的变化写进 HANDOFF-APP.md。

### 1.3 检查（命令和应得的数量）

```bash
cd dashboard && npm test                    # 130 项全部通过（2026-10-03）
npx tsc --noEmit -p .                       # 无输出
npm run lint                                # 无报错
cd ../twin && npm test                      # 15 项全部通过
npm run typecheck                           # 无报错
cd .. && bash twin/sync_to_dashboard.sh     # 改过 twin/src 时必须重建
cmp twin/dist-single/index.html dashboard/public/twin/index.html && echo identical
cd vision && .venv/bin/python -m unittest test_aid_verifier test_monitor_zone test_signal_delivery test_bridge_signals   # 49 项
```

TypeScript 报 `react 3`、`stats 2.js` 这类类型库时，删掉重复目录再跑：
`find dashboard/node_modules/@types twin/node_modules/@types -maxdepth 1 -name "* [0-9]*" -exec rm -rf {} +`

改了中枢或检测桥的逻辑时，再跑握手自检（17 种情况，约 5 分钟，用空闲端口的中枢，不要对着正在演示的中枢）：

```bash
cd dashboard && BRIDGE_PORT=8887 node backend/server.mjs                                     # 终端一
curl -X POST http://127.0.0.1:8887/api/settings -H 'Content-Type: application/json' -d '{"mode":"rules"}'   # 没有 key 时必须先切到规则模式
cd vision && .venv/bin/python rehearse_live.py --bridge-url http://127.0.0.1:8887            # 终端二，17 种情况全部 ok
```

数量变了要说明原因（新增或删除了哪些测试），写进提交说明。

### 1.4 回放验收（三类需求 + Reset）

```bash
bash start_demo.sh demos/captures/venue
```

打开 <http://127.0.0.1:3000>（只开一个标签页），在摄像头面板下方的 **Replay full flow** 依次点：

| 按钮 | 应看到 |
|---|---|
| ▶ Wheelchair | 约 5 秒进站，公交驶入、下蹲、开门、伸坡道；约 15 秒 On board；轮椅乘客沿坡道进到轮椅位（16 秒） |
| ▶ Stroller | 坡道不伸；On board 后乘客推车进门，把推车停进轮椅位，再单独走到分配的座位（S02/S03 优先）坐下，推车留在轮椅位（22 秒）；标题 "Park the stroller, then …" |
| ▶ Cane | 坡道不伸；乘客走到分配的座位（16 秒） |

每一类结束后按指引栏右侧的 **Reset**：指引回到 "No active booking"，孪生是空车（车门关、没有乘客或推车、座位占用回到初始）。dashboard 和手机（如有）显示同一份指引和同一个位置。

用 DeepSeek 时每次预约是一次付费调用，三类各一次就够；只验逻辑可在 dashboard 选 **Offline rules**。

### 1.5 提交到 main

```bash
git add -A && git commit        # 说明：取了什么、改写了什么、检查数量
git checkout main && git merge --no-ff integrate-<name> && git push origin main
```

在 HANDOFF.md 加一节记录这次合并，并更新第 4 节的表格。

---

## 2. 标准逻辑清单（每个分支都用它来对照）

1. 一次只服务一位乘客；一部手机依次扮演多位乘客；每段旅程用一辆新的模拟公交，只有预约重叠时才共用一辆（等待名单只是安全网）。
2. App 预约 → 规划只跑一次（LLM 或规则）→ `BOOKED`；摄像头信号一且辅具与预约一致 → `AT_STOP`，10 秒进站（同一辆车的后一位是 3 秒，`docked:true`）；摄像头信号二（停留后朝车离开，`zone.boarding !== false`）→ `ON_BOARD`；辅具不一致只等待。
3. 不会卡住：回到区域取消挂起的离站；8 秒收不到这次进站的消息按离开处理；在站台等待时预约有效期暂停。
4. 手机和 dashboard 各自结束旅程：手机的 Finish 只清空手机自己（中枢记 `passenger_finished`，dashboard 继续显示已上车和动画）；dashboard 的 Reset（带 `operator_reset:true`）结束旅程，换新车，回到干净的空闲画面。不按 Reset 直接预约下一位也立即开始，没有别人排队时换新车。
5. 手机和 dashboard 显示中枢生成的同一份指引；显示的位置就是规划的 `boarding_target`；`journeys[]` 每个预约一条。
6. "Preview boarding" 只在本机播放上车一半；"Replay full flow" 预约一个需求，录像、信号和孪生一起走完；"Reset" 清屏。
7. 同一辆车上位置不重复：已上车和已规划的位置（包括婴儿车同时占用的座位和轮椅位）都算占用，没有位置时 `no_place`，换新车后重新规划。
8. LLM 只能原样返回服务端给的目标和路线，校验不过就退回规则或安全兜底；规则和 LLM 两条路径的结果结构相同。

---

## 3. 已吸收的分支

| 分支 | 取了什么 | 改写了什么 |
|---|---|---|
| `codex/seat-guidance`（PR #3） | 按车厢占用分配座位的 `boarding_target`（LLM 必须原样返回）、各类辅具的车内引导动画、可滚动的乘客显示 | 信号二仍自动播放上车一半，"Preview boarding" 只作演示；上车一半换成走到分配位置的动画；`journey.seat` 取规划的目标 |
| `codex/journey-navigation-v05` | v0.5 旅程模型（`journey_id`、`animation`、`navigation`）、LLM 生成的车内分段指引、`visit_id` | 作为 dashboard/ 和 twin/ 的基础；补回 main 的上车意图判断（`zone.boarding`）和手动 Preview；检测桥和文档保留 main |
| `codex/import-buspulse-app` | 原生 iOS App（`app/`） | PR #4 曾被回退，后重新放入并改为跟随中枢旅程：三轮界面、分配位置、车内步骤、内嵌孪生 |
| `codex/main353765a-stroller-navigation`（v0.6） | 婴儿车停进轮椅位、乘客单独走到附近座位（S02/S03 → S05/S06 → S08/S09）；`equipment_target`；`PARK_STROLLER` 步骤；22 秒上车动画；孪生的推车与乘客分离 | 放进等待名单和新车逻辑：同车时婴儿车占座位和轮椅位两处，Reset 和新车同时释放；第 3 轮标题写明先停推车；停车和走向座位的镜头保持 Cutaway；同车后一位到站车门不再先关再开（见 HANDOFF.md 9.2） |

---

## 4. 待吸收：dashboard 界面分支（名称待定）

> 本节留空，分支到达后填写：分支名、它改了哪些界面、和第 2 节逐条对照的结果、检查数量、回放验收结果。

- 分支：
- 取了什么：
- 改写了什么：
- 检查：
- 回放验收：
