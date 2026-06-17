# XY chart reference (`xychart-beta`)

**Load this when:** the user asks for a chart / 图表 / bar chart / line chart / trend / 时间序列 / distribution / burndown / dashboard-style visualization.

> Mermaid accepts both `xychart-beta` and `xychart` as the first line. The renderer auto-detects.

## Axis configuration

- Categorical x-axis: `x-axis [A, B, C]`
- Numeric x-axis range: `x-axis 0 --> 100`
- Axis title: `x-axis "Category" [A, B, C]` (string before the bracket list)
- Y-axis range: `y-axis "Score" 0 --> 100`
- Horizontal: prefix the first line with `xychart-beta horizontal`
- Optional `title "..."` at the top

## Bar chart

```mermaid
xychart-beta
    title "Monthly Revenue"
    x-axis [Jan, Feb, Mar, Apr, May, Jun]
    y-axis "Revenue ($K)" 0 --> 500
    bar [180, 250, 310, 280, 350, 420]
```

## Line chart

```mermaid
xychart-beta
    title "User Growth"
    x-axis [Jan, Feb, Mar, Apr, May, Jun]
    line [1200, 1800, 2500, 3100, 3800, 4500]
```

## Combined bar + line

```mermaid
xychart-beta
    title "Sales with Trend"
    x-axis [Jan, Feb, Mar, Apr, May, Jun]
    bar [300, 380, 280, 450, 350, 520]
    line [300, 330, 320, 353, 352, 395]
```

## Horizontal orientation

```mermaid
xychart-beta horizontal
    title "Language Popularity"
    x-axis [Python, JavaScript, Java, Go, Rust]
    bar [30, 25, 20, 12, 8]
```

## Multi-series

Add multiple `bar` and/or `line` declarations. Each series gets a distinct color from a monochromatic palette derived from the theme's accent color.

```mermaid
xychart-beta
    title "2023 vs 2024 Sales"
    x-axis [Q1, Q2, Q3, Q4]
    bar [200, 250, 300, 280]
    bar [230, 280, 320, 350]
```

```mermaid
xychart-beta
    title "Planned vs Actual"
    x-axis [Jan, Feb, Mar, Apr, May, Jun, Jul, Aug]
    line [100, 145, 190, 240, 280, 320, 360, 400]
    line [90, 130, 185, 235, 275, 340, 380, 420]
```

## Numeric x-axis

```mermaid
xychart-beta
    title "Distribution Curve"
    x-axis 0 --> 100
    line [4, 7, 13, 21, 31, 43, 58, 71, 84, 91, 95, 91, 84, 71, 58, 43, 31, 21, 13, 7, 4]
```

## Real-world example: sprint burndown

```mermaid
xychart-beta
    title "Sprint Burndown"
    x-axis [D1, D2, D3, D4, D5, D6, D7, D8, D9, D10]
    y-axis "Story Points" 0 --> 80
    line [72, 65, 58, 50, 45, 38, 30, 22, 12, 0]
    line [72, 65, 58, 50, 43, 36, 29, 22, 14, 0]
```

## Real-world example: 12-month dataset

```mermaid
xychart-beta
    title "Monthly Active Users (2024)"
    x-axis [Jan, Feb, Mar, Apr, May, Jun, Jul, Aug, Sep, Oct, Nov, Dec]
    y-axis "Users" 0 --> 30000
    bar [12000, 13500, 15200, 16800, 18500, 20100, 19800, 21500, 23000, 24200, 25800, 28000]
    line [12000, 13500, 15200, 16800, 18500, 20100, 19800, 21500, 23000, 24200, 25800, 28000]
```

## Don'ts

- Don't add a y-axis range that doesn't include your data values (the renderer will clip)
- Numeric values must be actual numbers — no units (`"180k"` is invalid; use `180` with a y-axis title `"Revenue (k)"` instead)
- `x-axis` and `y-axis` are single-line; no `x-axis [A, B, C]` + `x-axis [...]` on a second line
- Don't mix categorical and numeric x-axes — pick one
- For pie/donut/radar charts, this **doesn't work** — see `swaps.md` for the closest supported alternative

## More

For more XY chart examples (multi-series, horizontal combined, time-series distributions) see `docs/beautiful-mermaid-examples.md` in the repo.
