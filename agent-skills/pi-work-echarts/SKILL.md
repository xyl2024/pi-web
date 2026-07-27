---
name: pi-work-echarts
description: 指导 pi agent 在 Pi Work 前端中输出合法的 echarts 围栏代码块。当用户要求画图、绘图、做可视化、plot、chart、画一个图、出个图、散点图、柱状图、饼图、折线图、热力图、桑基图等等，或你即将在 pi work 聊天消息中输出 echarts 代码块时，都应使用本 skill。涵盖 3 种合法形态（裸表达式 / 语句体带 `option =` / 显式 `return`）、`await` 异步取数，以及会静默失败的功能（echarts-gl 3D、`echarts.registerMap` 外部 geoJson、事件处理器、顶层 `import`）。
---

# pi-work-echarts

当 pi work 前端 UI 在 Markdown 中遇到 echarts 代码块时，会把代码块体当作 JS 求值，把得到的 `option` 对象渲染成可交互的 canvas 图表。

## 3 种合法形态

### 形态 A：裸对象表达式（最简单，不需要辅助变量时用）

```echarts
{
  title: { text: '...', left: 'center' },
  xAxis: { type: 'category', data: [...] },
  yAxis: { type: 'value' },
  series: [{ type: 'bar', data: [...] }]
}
```

### 形态 B：语句体 + `option = ...`（需要辅助变量时用）

`option =` 可以出现在任意位置 —— 即使前面有 `const` / `let` 声明或函数定义。不要在末尾追加 `return option;`，pi work 会自动补上。

```echarts
const data = [...];
const colors = [...];
option = { series: [{ type: 'scatter', data, itemStyle: { color: ... } }] };
```

### 形态 C：显式 `return`（同样可用）

```echarts
const chartOpt = { series: [{ type: 'pie', data: [...] }] };
return chartOpt;
```

## pi work 已经帮你做的事 —— 不要重复

- **不要**调 `echarts.init(...)`。canvas 生命周期、主题、resize observer 都由 pi work 管理。
- **不要**自己包一层 IIFE 或 `Function(...)`。pi work 已经用 `new Function("echarts", body)` 包好了，语句体会再套一层 async IIFE。
- **不要**为大型外部 geoJson 调 `echarts.registerMap(...)` —— 没地方传进来；只能 inline。
- **不要**用 `type: 'bar3D' / 'scatter3D' / 'globe'` —— pi work 引入的 `echarts` 包是 2D core，未安装 `echarts-gl`。
- **不要**写顶层 `import ... from 'echarts'` —— `new Function` 的 body 不支持模块语法。
- **不要**指望 `chart.on('click', ...)` 做交互 —— chart 实例没暴露给你的代码。

## 异步数据 —— `await` 可用

语句体路径会被包在 async IIFE 里，所以可以直接 `await fetch(...)`。在 await resolve 之前，代码块显示 "Rendering…" 占位符，await 完成后图表替换上来。

```echarts
const res = await fetch('/api/sales?range=30d').then(r => r.json());
option = {
  xAxis: { type: 'category', data: res.map(r => r.month) },
  yAxis: { type: 'value' },
  series: [{ type: 'line', smooth: true, areaStyle: {}, data: res.map(r => r.total) }],
};
```

并行 fetch 也支持：

```echarts
const [users, orders] = await Promise.all([
  fetch('/api/users').then(r => r.json()),
  fetch('/api/orders').then(r => r.json()),
]);
const counts = users.map(u => ({
  name: u.name,
  value: orders.filter(o => o.userId === u.id).length,
}));
option = { series: [{ type: 'treemap', data: counts }] };
```

**注意**：没有超时机制。如果 `fetch` 永远不 resolve，代码块会一直停在 "Rendering…"，需要用户编辑代码触发重新求值。


## 常见陷阱

- **`option = {...};` 末尾的分号无所谓**，pi work 会处理。
- **顶层直接写对象字面量**也能跑，因为 eval 用 `(...)` 强制包成表达式。如果你本来要写 `return {...}` 在多语句体顶部，直接 `option = {...}` 就行，省一半字数。
- **代码块里 `console.log` 用户看不到**。DevTools 里能看到，仅用于调试。
- **主题自动切换** —— pi work 在 UI 切到深色时给 `echarts.init` 传 `'dark'`。不要硬编码 `backgroundColor`，除非你故意要和主题对抗。
- **每次代码改动都重新 init**。不要试图跨求值保持状态 —— 每次编辑都是一次全新运行。
- **代码不要太长**：超过几千行会让首次渲染变慢，因为 pi work 在每次代码变更时都会重跑 eval 和读 `getComputedStyle`。
