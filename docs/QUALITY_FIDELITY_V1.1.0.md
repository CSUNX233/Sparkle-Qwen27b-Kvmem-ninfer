# v1.1.0 质量、检索与部署记录（2026-11-11）

本文是 v1.1.0 的公开汇总，包含两项底层引擎改动、RK4V4 + GDN FP32 部署切换和 dsh 状态卡。原始私有请求、会话和日志留在本机；本页与 `benchmarks/evidence/v1.1.0/` 只保留脱敏汇总。

## 1. 两个底层引擎改动

### 1.1 完整查询评分后补齐高分页的前邻页

问题：重要证据可能跨两个 KV 页，旧选择只选中后半页。修复分两部分，均只在检索路径生效：

1. **补齐前邻页**：在近期范围的重叠检索名额内，用高分冷页的前一页替换近期范围中排名靠后的成员；每次最多补 8 页（实现同时限制为选中数的 1/8），检索总页数不增加，原排名中的冷页全部保留。它不扩大页池、不新增 GPU 常驻数组，也不改变评分公式。
2. **等完整查询评分后再补页**：只有读到已知 query 结束位置，且完整捕获查询已经评分后，才允许补页；超长 user 保留原尾部评分方式，但必须读到其结束后才补。未知或未完成 query 保持原选页。这修复了上一候选在 218K 用例中“只读了一部分就改选页”的退化。

实现位置：`engine/src/ops/kvmem/kvmem_select.cpp`、`kvmem_select.h`、`overlap_predecessors.h`、`engine/src/models/qwen3_5/program/storage/context.cpp`。补丁：[deferred-neighbor-c287b7d.patch](../benchmarks/qualification/deferred-neighbor-c287b7d.patch)。

开关：启动前 `NINFER_KVMEM_OVERLAP_PREDECESSOR=1` 开启；设为 `0` 恢复 v1.0.0 选页。v1.1.0 启动器默认开启，可用 `OverlapPredecessor: false` 关闭。

**默认关闭的审计日志**：设置 `NINFER_KVMEM_RANK_AUDIT_DIR=<目录>` 才会导出每代页分数/入选状态和最终页名；未设置时不写文件、不改变选页。该目录可能包含 prompt 相关页号，不应上传公开日志。

| 测试 | 原日常 1.0.0 | 当前日常（含本修复） |
|---|---|---|
| 110K 长文任务 | 耗尽 4096 输出额度，无最终答案 | **12/12，完整完成** |
| 218K 长文任务 | 26/26 | **26/26，完整 JSON 与正确基线一致** |

- 110K：`finish=stop`，733 输出 token，峰值 11,232 MiB，275.9 秒；原日常为 4,096 额度耗尽、无答案。
- 218K：`finish=stop`，峰值 11,240 MiB；未修复候选为 25/26。
- 同谱系关闭态基线峰值为 11,230 / 11,242 MiB；本轮 110K 高 2 MiB，不能表述为严格零增量。所有峰值为 0.5 秒采样，不承诺瞬时上界。
- 只复测这两个用例，未重跑完整场景矩阵；不能据此宣称所有长任务都已解决。

### 1.2 畸形工具外壳最小修复

现场输出是完整 `<tool_call>` 外壳内的 `=job_output>`，缺少 function 开标签，参数标签也不合法。旧解析器把它当普通文本，dsh 随后正常 stop，用户看到空回合。

修复只识别“整个回答除空白外恰为这种完整外壳、合法函数名、parameter 起始和完整结束”的情形，将其送入已有的 `malformed_tool_call` 错误路径。它不猜测或执行原参数，错误参数中附带正确的 Qwen 标签例子与 `intended_function`，提醒不要再次调用错误占位名。普通文字、Markdown 围栏/行内代码、截断外壳和合法 `job_output` 保持原路径。

实现位置：`engine/src/models/qwen3_5/frontend/tool_call_parser.cpp`；补丁：[tool-envelope-c287b7d.patch](../benchmarks/qualification/tool-envelope-c287b7d.patch)。完整 C++ 解析器套件及新增回归通过；现场字符串逐字节回放只产生一个错误占位，不执行 `job_output` 或 `write`；真实 dsh 工具运行时的 unknown-tool 反馈与原生 Qwen 纠正路径已单次验证。未新增自动重试、强制采样、历史裁剪或后台执行，未重跑 110K/218K。

## 2. RK4V4 + GDN FP32 部署切换

日常 `run_local.cmd` 从 `nvfp4 + GDN FP16` 改为 **`rk4v4 + GDN FP32`**；页池 39,168、检索 6,144、Host KV 7,168 MiB、sink 12,288、recent 19,456、MTP3、chunk128、xhigh 和采样不变。v1.1.0 源码启动器默认改为 RK4V4，并移除 `--gdn-state-fp16`；公开示例仍保留较保守的 36,864 / 3,840 起步档。

| 配置 | 池 | GDN | 峰值 MiB | 相对原日常 |
|---|---:|---|---:|---:|
| 原日常 NVFP4 | 39,168 | FP16 | 11,168 | — |
| RK4V4 | 39,168 | FP16 | 11,148 | -20 |
| NVFP4 | 38,528 | FP32 | 11,226 | +58 |
| **RK4V4（当前）** | **39,168** | **FP32** | **11,220–11,236** | **+52…+68** |

显存增量满足 +100 MiB 约束，但运行时余量只有约 12 MiB；这是维护者机器的全池进阶档，不是公开默认保证。若 OOM，先把池降到 38,912 / 38,400，不要先降质量或删历史。

### 短上下文 39 题（首 token 分布，temp 0，thinking off）

| 配置 | 正确 | 相对 BF16 TV | 预测翻转 |
|---|---:|---:|---:|
| BF16 | 35/39 | 0 | — |
| FP8 | 36/39 | 0.0152 | 1 |
| RK4V4 + GDN16 | 35/39 | 0.0224 | 0 |
| **RK4V4 + GDN32** | **35/39** | **0.0262** | **0** |
| NVFP4 + GDN32 | 34/39 | 0.0288 | 1 |
| NVFP4 + GDN16 | 35/39 | 0.0299 | 2 |
| k8v4 | 34/39 | 0.0315 | 3 |

同配置重复运行逐位相同，说明该测试路径确定性可复现。RK4V4 的 TV 和预测翻转不劣于 NVFP4；thinking-off 下 `3^5-2^6` 会固定答 211，xhigh 日常路径 4/4 正确，不能用 thinking-off 判断日常质量。

### 长上下文合成针

| 测试 | RK4V4 | NVFP4 | 备注 |
|---|---:|---:|---|
| 110K / 12 顺序针 | 12/12 | 12/12 | FP8 8/12（池太小） |
| 159K / 16 顺序针 | 16/16 | — | |
| 232K / 24 顺序针 | 24/24 | — | 顺序码可外推，夹具偏容易 |
| 232K 随机顺序压力 | — | — | 多轮结果不稳定且跨格式共性，不纳入发布结论 |

### 真实内容 189,954-token 多轮

87 个 Python 模块 + 日志、35 条消息；8 条早期对话记忆事实在 190K 之前，16 个代码事实分散在代码中，24 题 JSON。

| 臂 | 配置 | 语义通过 | 输出 token | 耗时 |
|---|---|---:|---:|---:|
| A | **RK4V4 + GDN32（日常）** | **24/24** | 328 | 387 秒 |
| B | NVFP4 + GDN32 | 24/24 | 303 | 346 秒 |
| C | rk8v4 + GDN32 | 24/24 | 325 | 357 秒 |

### P0 回归

22 条工具/JSON 与 v1.0.0 同分 20/22、同失败题；xhigh 下两道路线算术 4/4；66K 输入 + 3,668 token 长输出无 OOM。详细数据见 [quality-fidelity 记录](../benchmarks/evidence/v1.1.0/rk4v4-gdn32.json)。

## 3. dsh 状态卡（v1.1.0）

`integrations/dsh/local-agent/state-card.mjs` v0.1.2 在显著工具结果后追加确定性 `local-state-card` 消息：目标、当前文件、最近尝试、最后成功/错误、代码签名/常量摘要。触发：错误立即、`write`/`edit` 每次、`pwsh`/`bash` 每 3 次；上限 1,900 字符；不修改历史、工具参数、系统提示、采样、KV 或工具 schema。

本次修复和边界：

- 递归展开嵌套 `tool-result.content`，否则 web/headless 的错误和代码摘要为空。
- **媒体保护**：会话包含图片后停止注入，避免改变视觉会话的消息/token 边界。只影响新注入，不能修复旧的已压缩会话。
- 安装器默认把状态卡加入 web profile；`StateCard: false` 或 `LOCAL_STATE_CARD=0` 可关闭。
- 单测 8/8；5 次多文件重构 A/B 见下表。P0 条件同时临时放宽了 pruner，状态卡不是唯一变量；pruner 放宽和 bridge **未并入**日常。

| 运行 | 步数 | 工具调用 | 重复 | 上下文 | 输出 token | 耗时 s | 测试 |
|---|---:|---:|---:|---:|---:|---:|---|
| baseline 均值（n=5） | 16.0 | 25.4 | 2.40 | 53,825 | 22,000 | 348.0 | 5/5 |
| P0 均值（n=5） | 15.8 | 23.4 | 0.80 | 43,164 | 16,457 | 260.4 | 5/5 |

步数 -1.3%（基本持平）、调用 -7.9%、重复 -67%、上下文 -19.8%、输出/耗时 -25.2%。范围重叠，n=5 不构成统计显著；baseline r3/r4 已达 15 步/0 重复/36K，P0 r4 反而 19 步。稳定信号是重复与上下文更低，不是步数更少。逐次数据见 [state-card-5x.json](../benchmarks/evidence/v1.1.0/state-card-5x.json)。

### pruner 夹具（确定性，仅配置层）

464,400 字符上下文（约 116K token）+ 20,065 字符 `REPORT.md`，事实位于第 10,040 字符：

| 配置 | 裁剪 | 输出字符 | 中间事实 |
|---|---|---:|---|
| 默认 8192/4096/1024 | 是 | 5,159 | 丢失 |
| P0 65536/24576/8192 | 否 | 20,065 | 保留 |

模型级 >98K 测试没有区分：headless 的 occurrence-time hook 未实际 trim 20K 报告，模型还可用一次 103 字符的定向读取找回事实。因此 pruner 的定位是上下文卫生/成本，不是事实保真的唯一手段；相关代码只保留在实验层。

## 4. 已知问题：多图 + compaction 后 scatter

2026-11-11 22:34，一个 99 消息、7 个 media、compaction 之后的请求在 **prefill** 阶段报：

```text
scatter: expected src [D,V], indices [V], dst [D,T]
```

HTTP 500，turn 3 `PI_AI_ERROR`。`--recover-invariant-failures` 恢复了引擎，但该请求失败；失败会话的历史已经压缩，点“继续”会复用同一历史并再次失败。该错误发生在视觉/状态张量路径，与 RK4V4、GDN FP32 不是同一路径；当前处理是开新会话，并使用 v0.1.2 的媒体保护。根因尚未在引擎层修复，v1.1.0 不宣称已解决多图压缩场景。

## 5. 证据与复现

- `benchmarks/evidence/v1.1.0/engine-deferred-neighbor.json`：110K/218K、显存、哈希与开关。
- `benchmarks/evidence/v1.1.0/engine-tool-envelope.json`：解析器回归与边界。
- `benchmarks/evidence/v1.1.0/rk4v4-gdn32.json`：39 题、长针、190K、P0 汇总。
- `benchmarks/evidence/v1.1.0/state-card-5x.json`：10 次重构运行的脱敏指标。
- `benchmarks/evidence/v1.1.0/pruner-fixture.json`：pruner 配置层对照。
- `benchmarks/qualification/*.patch`：两个引擎补丁，可对固定源码复核。
- [DEFERRED_NEIGHBOR_FIX.md](DEFERRED_NEIGHBOR_FIX.md)、[TOOL_ENVELOPE_FIX.md](TOOL_ENVELOPE_FIX.md)：原始实现与验收记录。

这些数据不是统一基准：不同测试使用不同二进制（`71259a21…`、`516e31d0…`、`8b2c195e…`）、不同端口和夹具；不能把局部数字拼成端到端加速或普遍质量提升。所有私有路径、会话 ID、登录 token 和原始 prompt 已从公开数据中移除。