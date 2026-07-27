# Echarts 代码块渲染

Pi Work 支持在 Markdown 中识别 echarts  围栏代码块，把代码体作为 JS 求值，得到 ECharts `option` 对象后直接渲染成 canvas 图表。本文档描述其语法规则、交互能力、已验证的示例与已知限制。

## 1. 概述

```
┌────────────────────────────────────────────────────────────────┐
│  ```echarts                                                     │
│  // 你的 JS                                                      │
│  ```                                                            │
└────────────────────────────────────────────────────────────────┘
                            │
                            ▼
        ┌───────────────────────────────────────┐
        │  evalOption(code, echarts) → Promise  │  ← async IIFE 包装
        └───────────────────────────────────────┘
                            │
                            ▼ option
        ┌───────────────────────────────────────┐
        │  echarts.init(el, isDark?"dark":...)  │  ← canvas, ResizeObserver
        └───────────────────────────────────────┘
                            │
                            ▼
                         图表
```

要点：

- **不需要写 `new echarts.init(...)`**，Pi Work 帮你 init / dispose / resize。
- 代码块体内的 JS 会拿到一个名为 `echarts` 的实参（这是动态 import 的 echarts 模块本身）。可以调用其静态方法（如 `echarts.number.linearMap`），但一般用不到。
- 主体最终必须产生一个 ECharts `option` 对象。两种合法形态详见 §2。
- 整个求值过程包在 async IIFE 里，因此可以直接 `await`（§3.3）。

## 2. 三种合法代码形态

### 2.1 裸表达式（最常见）

直接写一个对象字面量。实现里用 `return (${code})` 包裹以确保 `{ ... }` 被解析为值而非块。

```echarts
{
  title: { text: '月度销售额', left: 'center' },
  xAxis: { type: 'category', data: ['1月','2月','3月','4月','5月','6月'] },
  yAxis: { type: 'value' },
  series: [{ type: 'bar', data: [120, 200, 150, 80, 70, 110] }]
}
```

### 2.2 多语句 + `option = ...` 赋值（推荐用于含辅助变量的图表）

`option = ...` 可以出现在任意位置，前面的 `const` / `let` 声明、`function` 定义等都不会破坏求值。末尾无需写 `return option;` —— 实现会强制追加。

```echarts
const dataAll = [
  [[10, 8.04], [8, 6.95], [13, 7.58], [9, 8.81], [11, 8.33]],
  [[10, 9.14], [8, 8.14], [13, 8.74], [9, 8.77], [11, 9.26]],
];
const markLineOpt = {
  animation: false,
  data: [[{ coord: [0, 3], symbol: 'none' }, { coord: [20, 13], symbol: 'none' }]],
};
option = {
  grid: [{ left: '7%', top: '7%', width: '40%', height: '40%' }],
  xAxis: [{ gridIndex: 0, min: 0, max: 20 }],
  yAxis: [{ gridIndex: 0, min: 0, max: 15 }],
  series: [
    { name: 'I', type: 'scatter', data: dataAll[0], markLine: markLineOpt },
    { name: 'II', type: 'scatter', data: dataAll[1], markLine: markLineOpt },
  ],
};
```

### 2.3 显式 `return`

也支持。`return` 一旦执行就早退，附加的 `return option` 不可达 —— 所以既可以返回 `option`，也可以返回任意一个临时变量名。

```echarts
const chartOpt = {
  series: [{ type: 'pie', radius: '60%', data: [
    { value: 1048, name: '搜索引擎' },
    { value: 735, name: '直接访问' },
    { value: 580, name: '邮件营销' },
  ] }],
};
return chartOpt;
```

## 3. 已验证的语法能力

### 3.1 嵌套结构、formatter 字符串、symbol 回调

ECharts `option` 的所有静态字段都按字面量传过去。函数类型的 `formatter` 用字符串即可（`'{b}: {c}'`），字符串模板也能正常解析。

```echarts
{
  tooltip: { trigger: 'item', formatter: '{a} <br/>{b}: {c} ({d}%)' },
  legend: { orient: 'vertical', left: 'left' },
  series: [{
    name: '访问来源',
    type: 'pie',
    radius: ['40%', '70%'],
    avoidLabelOverlap: false,
    label: { show: false, position: 'center' },
    emphasis: { label: { show: true, fontSize: 18, fontWeight: 'bold' } },
    labelLine: { show: false },
    data: [
      { value: 1048, name: '搜索引擎' },
      { value: 735, name: '直接访问' },
      { value: 580, name: '邮件营销' },
    ],
  }],
}
```

### 3.2 主题色与多 grid / 多 series

通过 `gridIndex` / `xAxisIndex` / `yAxisIndex` 关联 series 到具体坐标系，可同时画多张子图。

```echarts
{
  title: { text: "Anscombe's quartet", left: 'center', top: 0 },
  grid: [
    { left: '7%', top: '7%', width: '38%', height: '38%' },
    { right: '7%', top: '7%', width: '38%', height: '38%' },
    { left: '7%', bottom: '7%', width: '38%', height: '38%' },
    { right: '7%', bottom: '7%', width: '38%', height: '38%' },
  ],
  tooltip: { formatter: 'Group {a}: ({c})' },
  xAxis: [
    { gridIndex: 0, min: 0, max: 20 },
    { gridIndex: 1, min: 0, max: 20 },
    { gridIndex: 2, min: 0, max: 20 },
    { gridIndex: 3, min: 0, max: 20 },
  ],
  yAxis: [
    { gridIndex: 0, min: 0, max: 15 },
    { gridIndex: 1, min: 0, max: 15 },
    { gridIndex: 2, min: 0, max: 15 },
    { gridIndex: 3, min: 0, max: 15 },
  ],
  series: [
    { name: 'I',   type: 'scatter', xAxisIndex: 0, yAxisIndex: 0, data: [[10,8.04],[8,6.95],[13,7.58]] },
    { name: 'II',  type: 'scatter', xAxisIndex: 1, yAxisIndex: 1, data: [[10,9.14],[8,8.14],[13,8.74]] },
    { name: 'III', type: 'scatter', xAxisIndex: 2, yAxisIndex: 2, data: [[10,7.46],[8,6.77],[13,12.74]] },
    { name: 'IV',  type: 'scatter', xAxisIndex: 3, yAxisIndex: 3, data: [[8,6.58],[8,5.76],[8,7.71],[19,12.5]] },
  ],
}
```

### 3.3 异步数据（`await`）

代码体包在 async IIFE 里，因此可以直接 `await fetch(...)`。在 `await` resolve 之前显示 "Rendering…" 占位。

```echarts
const res = await fetch('/api/sales?range=30d').then(r => r.json());
const months = res.map(r => r.month);
const totals = res.map(r => r.total);
option = {
  xAxis: { type: 'category', data: months },
  yAxis: { type: 'value' },
  series: [{ type: 'line', smooth: true, areaStyle: {}, data: totals }],
};
```

也支持并行：

```echarts
const [a, b] = await Promise.all([
  fetch('/api/users').then(r => r.json()),
  fetch('/api/orders').then(r => r.json()),
]);
const merged = a.map(u => ({
  name: u.name,
  value: b.filter(o => o.userId === u.id).length,
}));
option = {
  series: [{ type: 'treemap', data: merged }],
};
```

## 4. 已知限制

| 场景 | 当前表现 | 备注 |
| --- | --- | --- |
| `echarts-gl`（3D / globe / bar3D 等） | ❌ 不支持 | `import("echarts")` 不含 gl 包；写 `type: 'bar3D'` 会渲染失败 |
| 自定义地图（`echarts.registerMap`） | ⚠️ 仅当 geoJson 已 inline 在代码块内 | inline 大 JSON 会拖慢首次渲染，且会持续占用内存 |
| 事件绑定（`chart.on('click', ...)`） | ❌ 不支持 | chart 实例未对外暴露 |
| 编程控制（`dispatchAction` / `setOption` 增量更新） | ❌ 不支持 | 每次 code 变化都是 `dispose + re-init` |
| SVG renderer | ❌ 仅 canvas | 全屏 overlay 因此需要新建实例（canvas 不可跨 DOM 移动） |
| 异步 timeout | ⚠️ 无超时机制 | `fetch` 永不 resolve 时占位会一直显示；用户需手动编辑代码触发重新求值 |
| 顶层 `import` 语句 | ❌ 语法错误 | `new Function` body 不支持 import |
