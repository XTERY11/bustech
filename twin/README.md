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
