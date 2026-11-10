# dsh-compact-kit

> **English:** A *timing* layer for context compaction in DeepSeek Harness — a waterline
> reminder that nudges the model to externalize what it still needs before compaction, plus
> model-initiated compaction that wakes itself up afterwards. Two independent switches, plain
> config file, no UI required.

给 DSH 补上上下文压缩的**时机**一半。原版 `@deepseek-ai/dsh-compaction-basic` 只在两个时刻动手：数 token 数到窗口 ×0.8，或者撞上 `CONTEXT_WINDOW_EXCEEDED` 兜底。它不知道「这一段还有没落盘的东西」，也不给 agent 任何话事权。

本插件只决定**什么时候压**，怎么压一行都不改。

## 两个开关

| 开关 | 作用 | 关掉之后 |
|---|---|---|
| `remind` | 水位快到线时，提醒模型先把「压成摘要就会死」的东西落到摘要之外 | 完全不提醒，退化成原版行为 |
| `proactive` | 模型自己预约一次压缩，压完自动唤醒它接着做 | 两个工具返回 unavailable |

两个开关**互不依赖**：提醒不需要压缩服务（它只读 `tokenMeter` / `llm`），所以引擎挂不上时提醒照样工作。这是刻意留的故障隔离——`inject` 里不写 `compaction`，是因为 cordis 的 inject 是硬门禁，一写进去，压缩服务缺失时连提醒都会一起不启动。

## 提醒线怎么算

```
0.8 线   = 0.8 × 窗口           （原版自动压缩线）
落盘余量 = max(2048, P90(单步输出) × reserveSteps)
提醒点   = 0.8 线 − 落盘余量     ，夹在 [窗口 × 0.55, 窗口 × 0.79]
```

由这个算法自然得到两个性质：

- **小窗口模型**：绝对余量占比大 ⇒ 比例更低，早一点提醒，存盘空间才够；
- **但下限 0.55** 保证不会因为余量估得大就无限提前。

窗口取法与官方一致：`session.requestHeader()?.config` 的 provider/model → `llm.resolveModelInfo()`。**拿不到窗口就不提醒**，绝不猜一个数字。

冷启动（样本 < `minSamples`）时用保守默认 **0.62**，并在 `compact_status` 里标注「推测」。

## 统计与推荐值

插件每步记录 `assistant/message` 的 `outputTokens`（含思考），取 **P90** 而不是平均——平均会被一堆小步稀释，要防的是「最贵的那一次落盘」。

样本存在 `~/.dsh/dsh-compact-kit-stats.json`，到 `minSamples` 个之后自动从「推测」切到「实测」。

## 配置

配置是**独立 JSON 文件**，不是 cordis patch：

```bash
cp dsh-compact-kit.json.example ~/.dsh/dsh-compact-kit.json
```

```json
{
  "remind": true,
  "proactive": true,
  "remindRatio": "auto",
  "reserveSteps": 4,
  "minSamples": 5,
  "minReserveTokens": 2048
}
```

- `remindRatio`：`"auto"` 用统计推荐值；给数字（0.3–0.95）就听你的。
- `reserveSteps`：一次落盘大概要几步。
- `minSamples`：多少样本之后从猜测切到实测。
- `minReserveTokens` / `minReserveRatio`：落盘余量的两个下限（见下）。

**改完立刻生效，不用重启**（插件每步 stat 一次文件 mtime，只在变化时重读）。文件写坏了会保留上一份配置，不会因为一个逗号就让功能罢工。

## 在 Web 上配置：`/idle-compact`

```
/idle-compact                       看当前设置、水位、提醒线、压缩线、样本数
/idle-compact set remind false      关掉水位提醒
/idle-compact set proactive false   关掉主动压缩
/idle-compact set remindRatio 0.65  手动指定比例（0.3–0.95），或 auto
/idle-compact set minReserveTokens 50000   落盘余量下限（token）
/idle-compact set minReserveRatio 0.05     落盘余量下限（窗口比例）
/idle-compact reset                 删配置文件、恢复内置默认
```

写在 DSH 的输入框里就能用，改完立刻生效。它注册在 `ctx.get("commands")` 上——拿不到命令服务就静默跳过，不会拖累其他功能。

**为什么是命令而不是图形面板**：DSH 的每个设置页都是插件自带一个 client 包（`package.json` 的 `dshClient` 声明 + 构建产物），没有「声明 config 就自动渲染表单」的通用机制。做面板要动构建链，而 `pnpm` 在 dsh 进程里往往不可用。命令是同一能力的轻量形态，先有它。

## 落盘余量为什么要有两个下限

提醒线 = 压缩线 − 落盘余量。余量估小了，提醒发出后模型还没落完盘，原版就到线压了——**这正是这个插件要防的事**。

余量取三者最大：

```
max( minReserveTokens , P90(单步输出) × reserveSteps , 窗口 × minReserveRatio )
```

第三条是兜底。踩过的坑：1M 窗口下 P90 只有 1679（采样里混进大量“只调一个工具”的短步），四步算出 6716 余量，提醒线离压缩线只剩 6716 ——等于提醒完立刻被压掉。加 5% 窗口兜底后，1M 窗口自动给 5 万。

## 安装

`~/.dsh/profiles/web/cordis.patch.yml` 里追加：

```yaml
- insert:
    - id: idle-compaction
      name: cordis:group
      group: true
      isolate:
        compaction: true
      config:
        - id: idle-compaction-engine
          name: '@deepseek-ai/dsh-compaction-basic'
          config:
            auto: false          # 硬约束：别和 preset 里那个自动压缩重复触发
        - id: idle-compact
          name: /绝对路径/dsh-compact-kit/index.js
```

**为什么按绝对路径而不是装成包**：`dsh plugin` 依赖 `pnpm`，而 dsh 进程的 PATH 里可能没有它。绝对路径能跑，且改完源码重启即生效。

**代价**：目录一旦挪走或改名，插件会静默不加载。挪动时必须同步改这一行。

只想被提醒、不要主动压缩：把 `idle-compaction-engine` 与 `proactive` 关掉即可，提醒不受影响。

## 验证

1. 重启后日志：`[idle-compact] loaded; remind=true proactive=true config=...`
2. `compact_status`：能报出窗口、提醒线、压缩线与样本数。
3. 真跑一段，等水位过线：下一步会收到 `source.kind = compact-guard` 的提醒。
4. 压完后会话日志里应是：

```
turn/end → compaction/start(turn=null) → compaction/summary → compaction/end(turn=null)
        → turn/start → user/message(source.kind=idle-compact)
```

紧跟其后的 `turn/start` 才是「压完接着做」的证据。

## 回退

删掉 `cordis.patch.yml` 里那个 `idle-compaction` 组，重启即可；官方配置一行没动。

## 已知边界

- **不做压缩前确认**：提醒发出后模型可以选择不压，到 0.8 原版照样兜底。这是刻意的——真正的「压前拦截」意味着可以无限推迟，等于把兜底拆了。
- **没有 Web 配置面板**（规划中）。能力都在配置文件和 `compact_status` 里，面板只是可选呈现。
- **提醒只在每个 turn 响一次**，否则每步都响比不提醒更烦。
- **`lab/overlay.yml` 不许裸跑**：不加 `DSH_HOME=<隔离目录>` 的话，那个进程会往真实 `~/.dsh/sessions/` 里写一条会话，在 Web UI 的「未分组」里凭空多出来。
