# Bus Digital Twin

电动城市公交（参考图：新加坡石灰绿低地板公交）的可嵌入 3D 数字孪生原型。
React + TypeScript + Three.js + React Three Fiber + drei，Vite 工程。

## 运行

```bash
npm install
npm run dev            # http://localhost:5173
npm run build          # 常规构建 → dist/
npm run build:single   # 单文件 HTML → dist-single/index.html（可直接双击打开）
```

## 数据流

```
MockBusSimulator / WebSocket / MQTT ...        （车辆或模拟器）
        │  TelemetryMessage（原始遥测）
        ▼
adapters/telemetryAdapter.ts  normalizeTelemetry()   （状态归一化，唯一了解报文格式的地方）
        │  VehicleStatePatch
        ▼
state/vehicleState.ts  VehicleStore.setVehicleState() （语义状态）
        │  VehicleState
        ▼
<BusDigitalTwin state={…} />
   ├─ state/animationController.ts  状态 → 目标值 → 0..1 插值通道（可中断、可反向）
   ├─ state/presentation.ts         状态 → 卡片 / 高亮 / 地面提示 / 登车步骤（纯函数）
   └─ 3D 部件在 useFrame 中读取插值，直接写入变换（不触发 React 重渲染）
```

演示面板只向 MockBus 发**命令**，永远不直接操作网格；3D 组件只看 `VehicleState`。

## 嵌入

```tsx
import { BusDigitalTwin } from './components/BusDigitalTwin';

<div style={{ width: 800, height: 500 }}>
  <BusDigitalTwin
    state={vehicleState}              // 必填：语义状态
    onAction={(a) => console.log(a)}  // 可选：点击部件 / 动画到位 / 视角切换
    onAnimationUpdate={(v) => …}      // 可选：doorOpenAmount 等 0..1 值（约 12Hz）
    theme="light"                     // 'light' | 'dark'
    showHud                           // 状态标签、登车步骤、广播条
    showCameraPresets                 // Overview / Entrance / Ramp
    cameraPreset="entrance"           // 可选：受控视角
  />
</div>
```

组件填满父容器，已在 1200×700、800×500、600×400 与手机竖屏下验证；按需渲染（静止时不耗 GPU）。

## 接入真实遥测

```ts
import { connectTelemetry, WebSocketTelemetrySource } from './adapters/telemetryAdapter';
const stop = connectTelemetry(store, new WebSocketTelemetrySource('wss://gateway/bus-01'), 'bus-01');
```

报文示例（字段别名如 `deployed`、`stowed` 会被归一化）：

```json
{ "vehicleId": "bus-01", "timestamp": 1720000000, "door": "open", "ramp": "extended",
  "kneeling": true, "announcement": { "active": true, "text": "Wheelchair boarding in progress." } }
```

浏览器控制台可直接试：

```js
twin.setVehicleState({ door: 'opening', kneeling: true })
twin.telemetry({ door: 'open', ramp: 'deploying' })
```

（演示中 MockBus 会持续发布完整快照，手动写入会被它的下一帧覆盖。）

## 目录

```
src/
├── types/vehicle.ts                 VehicleState、动画值、事件类型
├── state/
│   ├── vehicleState.ts              可订阅 store + useVehicleState
│   ├── animationController.ts       插值通道（门 1.2s，坡道 2.0s，跪姿 1.6s）
│   └── presentation.ts              语义状态 → 可视化表达
├── adapters/telemetryAdapter.ts     归一化 + WebSocket 源
├── simulation/
│   ├── mockBus.ts                   模拟车辆：命令、机械时序、安全联锁
│   └── boardingScenario.ts          无障碍登车时间线（Run Boarding Demo）
├── components/
│   ├── BusDigitalTwin/
│   │   ├── BusDigitalTwin.tsx       画布、HUD、动画驱动
│   │   ├── BusModel.tsx             场景层级（BusRoot / SprungBody / …）
│   │   ├── Door.tsx                 双扇外摆塞拉门 DoorLeafA / DoorLeafB
│   │   ├── Ramp.tsx                 抽出 + 下翻坡道，实时求解落地角
│   │   ├── DestinationDisplay.tsx   Canvas 纹理 LED 路牌
│   │   ├── VehicleCallouts.tsx      锚定玻璃卡片、广播波形
│   │   ├── CameraRig.tsx            受限轨道相机与预设
│   │   ├── Stage.tsx                程序化柔光环境、接触阴影
│   │   ├── dimensions.ts            全部尺寸与锚点（换 GLB 时主要改这里）
│   │   └── parts/                   Body（CSG 门洞/轮拱）、Windows、Wheels、ExteriorLights、StatusIndicators
│   └── DemoControls/                仅原型使用的控制面板
└── App.tsx
```

## 替换为 GLB 模型

把 `parts/Body`、`Windows`、`Wheels`、`ExteriorLights` 换成 GLB 网格，并在 GLB 里保留
门扇、坡道的独立节点（或用 `dimensions.ts` 中的锚点挂载）。`Door.tsx` / `Ramp.tsx`
只需要两个门扇 group 和坡道 pivot group，状态与动画逻辑无需改动。

## B70A02 客舱与座位模拟

此版本参考 [Land Transport Guru 的 B70A02 页面](https://landtransportguru.net/byd-b70a02-autonomous-bus/)及其[客舱照片](https://landtransportguru.net/web/wp-content/uploads/2026/06/LTA-BYD-B70A02-Interior-1.jpg)、[轮椅区照片](https://landtransportguru.net/web/wp-content/uploads/2026/06/LTA-BYD-B70A02-Interior-3.jpg)，使用程序化几何近似复原，无额外模型或字体下载。

- **16 个固定座位**：低地板 9 座（其中 5 个红色优先座），后部高台 7 座，三阶台阶连接；普通座为蓝色。
- **F01 折叠座**：轮椅区另设 1 座，空置时折起，有人时放下。固定座统计不包含 F01；全满场景共 17 人。
- 空腔车身、透光车窗、地板、黄边台阶、扶手和吊环、安全带、简化驾驶区、刷卡器和随车辆目的地更新的车内屏幕。
- 默认混合场景为 7 人：S01、S04、S06、S08、S10、S13、S15；其余座位为空。乘客为简单坐姿模型。

**查看**：相机按钮 `Cutaway` 移除车顶及近侧上部车身；`Interior` 从入口看向车尾。点击 3D 座位可查看 ID、类型及占用状态。右侧座位图可逐个切换乘客，`Mixed`、`Empty all`、`Fill all` 载入预设，`Reset` 恢复默认占用。`Export seat state (JSON)` 导出当前状态。嵌入页支持 `?embed=1&camera=cutaway` 或 `camera=interior`。

**复原边界**：照片确认座位数量、分区、颜色和三阶台阶；精确间距、后排 4+3 排布、扶手位置及驾驶舱细节为建模近似。参考车辆长约 7 m，本次适配原有 7.6 m 车身，保留既有车门／坡道机构。模型不是厂家 CAD。仅模拟座位上的乘客，不模拟站立乘客或轮椅实际占用。

### 状态读取与更新

`src/data/cabinLayout.ts` 是布局和座位 ID 的唯一来源。坐标以米为单位，车头 -X、车尾 +X、上方 +Y、车门侧 +Z，位置随整个车身一起跪姿移动。座位占用存放在 `VehicleState.seatOccupancy` 中；渲染和导出读取相同状态。

```js
// 演示页：命令通过 MockBus → telemetry adapter → store → 3D 传播。
twin.bus.setSeatOccupied('S02', true)
twin.bus.setOccupancyPreset('mixed') // 'empty' / 'full'

// 演示页和嵌入页都可读取；返回纯 JSON 可序列化对象。
const cabin = twin.getCabinSnapshot()
// cabin.seats: [{ id, zone, kind, position, rotation, occupied }, ...]
// cabin.occupiedFixedSeats / availableFixedSeats / occupiedTotal
// cabin.schemaVersion = 1; cabin.layoutId = 'byd-b70a02-photo-v1'
// cabin.source = 'simulation'
```

组件调用方也可直接使用 `getCabinSnapshot(vehicleState)`。不需要遍历 Three.js 网格。

未来主机可沿用现有遥测通道发送增量字段：

```json
{ "vehicleId": "bus-01", "seatOccupancy": { "S02": true, "S15": false } }
```

只接受已知座位 ID 和布尔值，省略的座位保持原值；开关门、坡道和登车场景不会覆盖已模拟的乘客。演示页手动向 store 写入的状态仍可能被下一次 MockBus 完整快照覆盖，所以演示交互应使用 `twin.bus` 命令。嵌入模式由主机独占更新状态。

本次提供的是本地可读状态与 JSON 导出边界，尚未连接巴士后端、真实传感器或 LLM。`wheelchairOccupancy` 明确为 `not-simulated`，不能从 F01 空置推断轮椅区无人。

### 验证

```bash
npm test               # 布局约束、预设计数、命令到快照、增量校验、状态隔离
npm run build          # TypeScript + 生产构建
npm run build:single   # 单文件产物
```
