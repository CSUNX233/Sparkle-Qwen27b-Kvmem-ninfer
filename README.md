<div align="center">

# Sparkle-Qwen27b-Kvmem-ninfer

**在 12GB 笔记本显卡上运行 27B 本地 Agent**

NInfer 推理 · KVMem 分层 KV · MTP3 推测解码 · dsh Agent 工作台

[![Version](https://img.shields.io/badge/version-v1.2.0-2ea44f?style=flat-square)](docs/RELEASE_V1.2.0.md)
[![Engine](https://img.shields.io/badge/engine-f9a6b29c-0969da?style=flat-square)](docs/RELEASE_V1.2.0.md)
[![Platform](https://img.shields.io/badge/platform-Windows%20x64%20%2F%20sm120a-0078d4?style=flat-square)](docs/BUILD.md)
[![License](https://img.shields.io/badge/license-Apache--2.0-lightgrey?style=flat-square)](LICENSE)

[快速开始](#快速开始) · [v1.2.0 更新](#v120-更新) · [实测数据](#实测数据) · [文档地图](#文档地图) · [下载](https://github.com/CSUNX233/Sparkle-Qwen27b-Kvmem-ninfer/releases/tag/v1.2.0)

</div>

> **逻辑上下文 256K，不代表每一步都读取全部历史。** 长历史由 KVMem 存在 Host RAM，按检索结果调入 GPU；这减少了重复预填充，但不等于已完成满 256K 验收，也不保证每个任务都更快。

## 30 秒了解

| 问题 | 回答 |
|---|---|
| **这是什么？** | 一个面向本地代码/文件/网页任务的 27B Agent 运行栈：NInfer 引擎 + KVMem 长历史 + MTP3 + dsh 网页 / Pmod 桌面界面。 |
| **跑在哪？** | 维护者直接验证 **RTX 5070 Ti Laptop 12GB / i7-14650HX / 32GB RAM / Windows**；其他 12GB+ 显卡需要匹配架构的构建。 |
| **默认配置？** | Qwen3.8-27B GSQ-RCO IQ3_XXS + MTP3，**RK4V4 + GDN FP32**，DeviceKV 36864 / Retrieve 3840 / HostKV 7168 MiB，xhigh。 |
| **v1.2.0 的重点？** | 修复 CPU 视觉分块边界 `scatter`，为摘要截断增加有界恢复，并恢复 DSH 思考强度界面。 |
| **不适合什么？** | 不能把它当成“所有任务全面超过云端模型”或所有同名错误、工具循环均已消失的证明。 |

> **桌面端：** 仓库同时包含 [`desktop/`](desktop/) 的 **Pmod** 图形工作台（Tauri 2 + Vue 3.5），提供对话、模型配置、显存监控和 OpenAI 兼容网关；安装包构建脚本在 [`scripts/build-inno-installer.ps1`](scripts/build-inno-installer.ps1)。这是可选前端，不改变引擎和默认 Agent。

![Pmod 桌面端](docs/images/02-chat.png)

## v1.2.0 更新

**2026-11-14 后续源码更新（尚未发行新 Release）：** 本地模型自动压缩异常时停止当前轮并保留历史，避免继续发送未压缩的大请求；状态卡改为合并工具结果，成功编辑累计8次才注入一张，重复失败去重，普通读取/成功命令不再定时弹卡。28项隔离测试通过，尚未完成故障电脑真实长任务复测，不宣称所有循环已解决。[改动与验证范围](docs/DSH_COMPACTION_CANDIDATE_20261114.md)。本轮无需更换引擎附件；需更新安装中的 DSH 模块与补丁，单独替换 exe 不会生效。

- **图片分块修复**：CPU/host-staged 视觉与 MTP 同时启用时，图片首个视觉 token 正好位于预填充分块边界，旧引擎可能产生 `scatter` 形状错误；修复后真实模型边界请求通过，最坏情况暂存规划不增加。
- **压缩恢复**：本地模型摘要首次达到输出上限时，仅对这次摘要以 low 思考强度重试一次。重试不完整时保留原历史并停止当前轮；日常对话思考强度不变。
- **DSH 与部署**：恢复模型/思考强度选择界面，支持显式 GPU 视觉选项；公开默认页池仍为 36864/3840，默认不启用视觉。
- **验证范围**：真实长任务到约 212K 输入 token 时复现摘要截断；真实失败历史回放生成完整摘要，并在隔离会话中验证压缩后带两张截图的工具续接。首次续接曾出现额外调用，严格复测通过；不保证所有循环已解决。

[下载 v1.2.0 引擎附件](https://github.com/CSUNX233/Sparkle-Qwen27b-Kvmem-ninfer/releases/download/v1.2.0/ninfer-5070ti-win-x64-sm120a-v1.2.0.zip)（仅引擎，不含模型、DSH 或运行 DLL）。引擎 SHA-256 `f9a6b29cb7755b18ae02dcc130c17b5e28b2c97530c647db9936680bd5c2ad46`；[完整说明与验证边界](docs/RELEASE_V1.2.0.md)。源码更新后还需运行 `setup.ps1` 才会更新已安装的引擎和 DSH 补丁。

## v1.1.0 更新（历史）

验证引擎 SHA-256：

```text
8b2c195e32e3b58a3584b284679c990a07986691967f1b939b0fe31351559012
```

### 两项底层引擎改动

| 改动 | 作用 |
|---|---|
| **补齐高分历史页的前邻页** | 重要证据可能跨两个 KV 页，旧选择只命中后半页。新逻辑利用近期范围里的重叠检索名额补前页：每次最多补 **8 页**，只替换近期范围中排名靠后的成员，**检索总页数不增加，原排名中的冷页全部保留**。 |
| **等查询完整评分后再补页** | 只有读到已知 query 结束位置、且完整捕获查询已经评分后才允许补页；未知或未完成 query 保持原选页。这避免了“问题只读了一部分就改变选页”，修复上一候选在 218K 中的退化。 |

- 启动器默认开启；`NINFER_KVMEM_OVERLAP_PREDECESSOR=0` 可恢复 v1.0.0 选页。
- **选页诊断日志默认关闭**：只有显式设置 `NINFER_KVMEM_RANK_AUDIT_DIR=<目录>` 才导出每代分数/入选状态和最终页名；目录可能含 prompt 相关页号，不要上传公开日志。

| 测试 | 原日常 1.0.0 | 当前日常 |
|---|---|---|
| **110K 长文任务** | 耗尽 4096 输出额度，无最终答案 | **12/12，完整完成**（733 输出 token，`finish=stop`，275.9 秒，峰值 11,232 MiB） |
| **218K 长文任务** | 26/26 | **26/26，完整 JSON 与正确基线一致**（`finish=stop`，峰值 11,240 MiB） |

同谱系关闭态峰值为 11,230 / 11,242 MiB；110K 高 2 MiB，不能表述为严格零增量。只复测这两个用例，不宣称所有长任务都已解决。

**畸形工具外壳最小修复。** 现场回答是完整 `<tool_call>` 外壳内的 `=job_output>`，缺少 function 开标签且参数标签不合法；旧解析器把它当普通文本，dsh 随后正常 stop。新逻辑只识别“整个回答除空白外恰为这种完整外壳、合法函数名、parameter 起始和完整结束”的情形，送入已有的 `malformed_tool_call` 错误路径；**不猜测、不执行原参数**，错误参数中附正确 Qwen 标签例子和 `intended_function`。普通文字、Markdown 围栏/行内代码、截断外壳和合法 `job_output` 保持原路径。完整 C++ 解析器套件与新增回归通过；现场字符串逐字节回放只产生错误占位，不执行 `job_output` 或 `write`。

### 部署与 dsh 更新

- **默认 KV 改为 RK4V4 + GDN FP32。** 日常 39,168 / 6,144 配置峰值 11,220–11,236 MiB，相对原日常 11,168 MiB 增加 52–68 MiB，仍在 +100 MiB 约束内；运行时余量只有约 12 MiB。短上下文 39 题相对 BF16 的 TV 为 0.0262、预测翻转 0（NVFP4 为 0.0288 / 1）；真实内容 189,954-token 多轮 24/24。公开示例保留更保守的 36,864 / 3,840 起步档。
- **dsh 状态卡 v0.1.2。** 在显著工具结果后追加确定性状态卡（目标、当前文件、最近尝试、最后错误、代码签名/常量摘要）：错误立即、写入每次、shell 每 3 次，上限 1,900 字符。它不修改历史、工具参数、系统提示、采样或 KV。v0.1.2 修复嵌套 `tool-result.content`，并在会话包含图片后停止注入，避免改变视觉会话边界。
- **2026-11-12 后续修复（v0.1.3，main）。** 原触发用 `attempts.length % 3`，而 `attempts` 最多保留 8 条，存满后普通 shell 调用不再发卡。v0.1.3 改用独立 `shellCalls` 计数器；9 次 shell 的集成测试在第 3/6/9 次各发一张卡，旧实现只会发前两张。v1.1.0 Release 中的 dsh ZIP 仍是 v0.1.2；需要使用修复版请从 `main` 源码安装或等待下一次 dsh 包更新。
- 5 次多文件重构 A/B：P0 均值 **15.8 步 / 23.4 次调用 / 0.8 次重复 / 43,164 上下文 / 260 秒**；baseline **16.0 / 25.4 / 2.40 / 53,825 / 348 秒**；两边 5/5 测试通过。**步数只下降 1.3%，范围重叠，n=5 不构成统计显著**；方向性信号是重复调用、上下文、输出和耗时更低。pruner 阈值放宽和 `pruner-bridge` 仍是实验项，未并入日常。

### v1.1.0 的已知问题（历史）

多图 + compaction 后的一个请求在 **prefill** 阶段报：

```text
scatter: expected src [D,V], indices [V], dst [D,T]
```

99 条消息、7 个 media，HTTP 500；`--recover-invariant-failures` 恢复了引擎，但失败会话继续会复用同一压缩历史并再次失败。当前处理是**开新会话**，并使用 v0.1.2 的媒体保护。根因在视觉/状态张量路径，与 RK4V4 / GDN FP32 不是同一路径；本版不宣称已修复多图压缩场景。

### 安装与回退

- 源码标签：`v1.1.0`。
- 引擎附件：[`ninfer-5070ti-win-x64-sm120a-v1.1.0.zip`](https://github.com/CSUNX233/Sparkle-Qwen27b-Kvmem-ninfer/releases/download/v1.1.0/ninfer-5070ti-win-x64-sm120a-v1.1.0.zip)；压缩包 SHA-256 `daa2a6c5ab0c6a1715d839fcaf3ee4954c6c19d2641f9ee9aec6de083a3bae4a`，内含引擎 `8b2c195e…`。
- dsh 单独包：[`dsh-state-card-v1.1.0.zip`](https://github.com/CSUNX233/Sparkle-Qwen27b-Kvmem-ninfer/releases/download/v1.1.0/dsh-state-card-v1.1.0.zip)，SHA-256 `cf37d659dd7439841dda362c0c341ff04377655592e822cadc524f3fd8bf2ab1`；含 state-card v0.1.2、单测和手动 profile 片段；源码安装器已默认接入。
- 上一版回退：v1.0.0 引擎 `71259a21f7b525ca7477193a292e4d3623cc58b9efd785005ee934cc29673507`；v0.1.5 引擎 `38bc4d8c6be07afd6c74b902cc33403bf2ee139a2c50129d363d68d74a7609d6`。
- 只 `git pull` 不会替换旧 exe；升级已有安装需重新执行 `setup.ps1`。引擎仍显示 1.0.0 底座版本号，请以 SHA-256 和标签识别。

## 快速开始

### 方式 A：源码安装（推荐）

需要 **Node.js 24+**、**VC++ x64 运行库**、兼容 CUDA 13 的 NVIDIA 驱动，以及一个含 MTP 的 v3 `.ninfer` 模型。

```powershell
git clone https://github.com/CSUNX233/Sparkle-Qwen27b-Kvmem-ninfer.git
cd Sparkle-Qwen27b-Kvmem-ninfer
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1 `
  -ModelPath "D:\Models\qwen3.8-27b-gsq-rco-iq3-xxs.ninfer"
.\start.cmd
```

首次启动会下载固定哈希的引擎/依赖、加载权重并捕获 CUDA Graph。启动完成后，dsh 私有登录 URL 在 `runtime/logs/dsh.stdout.log`；**不要公开这个 URL**。

### 方式 B：引擎附件

下载上面的 `v1.2.0` ZIP，把 `ninfer-serve.exe` 放到 `runtime/engine/`，再运行 `setup.ps1` 完成依赖与配置。引擎附件不含模型、Node、dsh 或运行 DLL，不是完整整合包。

### 默认端口

| 服务 | 地址 |
|---|---|
| 引擎 API | `http://127.0.0.1:1234/v1` |
| 缓存守卫 | `http://127.0.0.1:1236/v1` |
| dsh 网页 | `http://127.0.0.1:3080` |

## 实测数据

> 以下不是统一基准：不同测试使用了不同二进制、端口和夹具。完整数据与限制见 [v1.1.0 质量保真记录](docs/QUALITY_FIDELITY_V1.1.0.md) 和 [`benchmarks/evidence/v1.1.0/`](benchmarks/evidence/v1.1.0/)。

### 短上下文保真（39 题，首 token 分布）

| 配置 | 正确 | 相对 BF16 TV | 预测翻转 |
|---|---:|---:|---:|
| BF16 | 35/39 | 0 | — |
| FP8 | 36/39 | 0.0152 | 1 |
| **RK4V4 + GDN32（默认）** | **35/39** | **0.0262** | **0** |
| NVFP4 + GDN32 | 34/39 | 0.0288 | 1 |
| NVFP4 + GDN16 | 35/39 | 0.0299 | 2 |

同配置重复运行逐位相同。thinking-off 下 `3^5-2^6` 会固定答 211；日常 xhigh 路径 4/4 正确，不能用 thinking-off 判断日常质量。

### 显存（整卡峰值，nvidia-smi）

| 配置 | 池 | GDN | 峰值 MiB | 相对原日常 |
|---|---:|---|---:|---:|
| 原日常 NVFP4 | 39,168 | FP16 | 11,168 | — |
| RK4V4 | 39,168 | FP16 | 11,148 | -20 |
| NVFP4 | 38,528 | FP32 | 11,226 | +58 |
| **RK4V4（当前）** | **39,168** | **FP32** | **11,220–11,236** | **+52…+68** |

这是维护者机器的全池进阶档，不是公开默认保证；运行时余量只有约 12 MiB。若 OOM，先把池降到 38,912 / 38,400。

### 长上下文与真实内容

| 测试 | 结果 | 说明 |
|---|---:|---|
| 110K / 12 顺序针 | 12/12 | RK4V4；FP8 同池只有 8/12 |
| 159K / 16 顺序针 | 16/16 | rk8v4 小池 |
| 232K / 24 顺序针 | 24/24 | 顺序码可外推，夹具偏容易 |
| 232K 随机顺序压力 | 未纳入结论 | 多轮结果不稳定且跨格式共性 |
| **189,954-token 真实内容多轮** | **24/24** | 16 代码事实 + 8 早期对话事实；三臂均 24/24 |

### 工具/JSON 回归

22 条工具/JSON 与 v1.0.0 同分 **20/22**、同失败题；xhigh 下两道路线算术 **4/4**；66K 输入 + 3,668 token 长输出无 OOM。

## 硬件与模型

| 硬件 | 建议 |
|---|---|
| **RTX 50 系，12GB+** | 直接使用本次 Windows x64 / sm120a 附件；实测设备为 5070 Ti Laptop 12GB。 |
| RTX 30 / 40 系，12GB+ | 需要对应架构的兼容构建；参考 [编译说明](docs/BUILD.md)，不能直接运行 sm120a 附件。 |
| 16GB 及以上 | 可选更大的 IQ3_S 文字模型；需另行准备含 MTP 的 `.ninfer` 并重新验证预算。 |

推荐 32GB 系统内存、SSD、兼容 CUDA 13 的驱动。不同架构需适配内核与依赖，改 exe 文件名不会改变 GPU 支持。

### 显存不足时

1. 开启混合显卡模式，让桌面/浏览器尽量使用核显。
2. 在 NVIDIA 控制面板中只对实际引擎关闭 **CUDA - Sysmem Fallback Policy**。
3. 关闭无关后台 GPU 应用。
4. 仍不足，配套缩小页池与检索窗口（如 34,560 / 1,536），保留 sink/recent/HostKV。
5. **NVFP4 不是省显存选项**；本版默认 RK4V4 已比同池 NVFP4 少约 20 MiB。

保留 KVMem 的 7 GiB Host KV，它与驱动自动回退不是一回事。缩检索窗口可能降低历史召回，切换 KV 格式也不保证相同输出。[完整步骤](docs/VRAM_GUIDE.md)

## 工作原理

```text
请求 → dsh Agent / 工具 → 缓存守卫 → NInfer 引擎
                                      ├─ GPU 热页（sink + recent + retrieve）
                                      ├─ Host KV（冷历史，按需回迁）
                                      └─ MTP3 推测解码
```

- **KVMem** 把长历史 KV 留在 Host RAM，按检索结果把需要的页调入 GPU；不是每步重读全部历史。
- **MTP3** 用 3 个 draft token 做推测解码，减少 decode 步数；日常保持原采样与 xhigh。
- **缓存守卫** 保持已发送前缀稳定，减少重复预填充；它不能让不同 token 前缀安全共享 KV。
- **dsh Agent** 提供编辑前校验、多动作账本、工具结果保真和状态卡；这些是行为/上下文层改动，不替代引擎质量。

## 文档地图

| 我想… | 先看 |
|---|---|
| **了解 v1.2.0 和测试边界** | [v1.2.0 更新说明](docs/RELEASE_V1.2.0.md) · [脱敏验证汇总](benchmarks/evidence/v1.2.0/validation.json) |
| **安装 / 升级 / 排错** | [安装说明](docs/INSTALL.md) · [部署维护手册](docs/DEPLOYMENT_AGENT_GUIDE.md) · [纠错文档](docs/TROUBLESHOOTING.md) |
| **了解 v1.1.0 改了什么** | [v1.1.0 质量保真记录](docs/QUALITY_FIDELITY_V1.1.0.md) · [Release Notes](docs/RELEASE_NOTES.md) |
| **核对两个引擎补丁** | [前邻页修复](docs/DEFERRED_NEIGHBOR_FIX.md) · [工具外壳修复](docs/TOOL_ENVELOPE_FIX.md) |
| **看原始/脱敏数据** | [`benchmarks/evidence/v1.1.0/`](benchmarks/evidence/v1.1.0/) · [`benchmarks/qualification/`](benchmarks/qualification/) |
| **自己编译** | [编译说明](docs/BUILD.md) · [修改范围](docs/MODIFICATIONS.md) |
| **dsh 插件 / Agent 行为** | [集成说明](integrations/README.md) |
| **历史版本** | [v1.0.0 查询层与执行层](docs/RELEASE_NOTES.md) · [v0.1.5 C2.1](docs/C2P1_V014_PORT.md) |

## 已知限制

- **没有完成满 256K 验收。** 逻辑容量是 262,144；实际 dsh 压缩阈值约 184K，长历史中段通过检索选页。
- **232K 随机串压力不代表真实任务。** 多轮结果不稳定且跨格式共性，不作为质量承诺；真实内容 190K 为 24/24。
- **`scatter` 不只有一种可能原因。** 本版修复了已稳定复现的 CPU 视觉分块边界问题；原故障机器日志缺失，不能断言所有同名错误已解决。[验证范围](docs/RELEASE_V1.2.0.md)。
- **状态卡 n=5 不构成统计显著。** 步数基本持平，收益主要在重复调用/上下文/耗时。
- **本次预编译引擎只覆盖 Windows x64 / sm120a。** 30/40 系与其他模型需自行构建/验证。
- **搜索需要互联网。** dsh 的网页/搜索不是离线索引，站点改版或验证码会导致失败。
- **私有原始请求、会话和日志留在本机。** 公开目录只保留脱敏汇总。

## 历史版本

<details>
<summary><b>v1.0.0 — 查询稳定性与 agent 执行校验</b></summary>

在 v0.1.5 的模型、NVFP4、39168/6144 页池、MTP3、xhigh、采样和回答惩罚设置不变的前提下，发布查询层与 agent 执行层升级：

- `related-tool-head`、`suffix refresh=tail`、`QUERY_ASSEMBLE=1`；真实 116,907-token 故障历史完整路径/合法 read-edit **1/4 → 4/4**，留出 8 seeds **4/8 → 8/8**。
- `edit-guard` 单文件精确替换执行前校验；`task-ledger` 多动作任务剩余提醒；结构化反馈后一次恢复 **10/10**（generic 0/10）。
- 因果 **8/8**、短续接 **10/12、7/12** 持平；旧延迟压力首轮仍 **2/4**；H7/H8/H11 拒绝并归档。
- 验证引擎 `71259a21…`；源码标签 `v1.0.0`。详见 [Release Notes](docs/RELEASE_NOTES.md) 与 [路径查询实验](docs/PATH_QUERY_EXPERIMENT.md)。

</details>

<details>
<summary><b>v0.1.5 — C2.1 长历史缓存恢复与批量回迁</b></summary>

在 v0.1.4 上移植 C2.1：滚动长锚点、同 lineage 锚点消费、冷页最多 32 页批量回迁。12 项定向回归通过；两个约 68K 夹具各 7 次请求，压缩前后藏针 7/7、状态/代码 6/6；最后一次压缩后续接复用 58,330/58,459 tokens，耗时 1.93/2.77 秒。整卡峰值约 11,176/11,174 MiB，无同条件 v0.1.4 对照。[完整记录](docs/C2P1_V014_PORT.md)

</details>

<details>
<summary><b>更早版本</b></summary>

v0.1.0–v0.1.4 的检索上下文、semantic history、NVFP4、工具解析、采样/惩罚和 C2.1 前序修复保留在源码与 [Release Notes](docs/RELEASE_NOTES.md)。历史测速与夹具见 [BENCHMARKS](docs/BENCHMARKS.md)；这些是不同阶段的记录，不能拼成一次统一测试。

</details>

## 许可与致谢

代码以 **Apache-2.0** 开源；第三方组件与模型分别适用各自许可。Huihui Swift 衍生部分适用 **Swift Open License v1.0**，含商业收入门槛，不能把整个模型当作纯 Apache-2.0。[模型与许可](docs/MODELS.md)

特别感谢 Bilibili [0xFFFF7](https://search.bilibili.com/upuser?keyword=0xFFFF7)：基础架构来自他分享的版本，此前的死循环问题也由他解决。基础引擎、KVMem 及其他作者归属见 [上下游与许可](docs/UPSTREAM_DOWNSTREAM.md) 与 [NOTICE](NOTICE)。

---

<div align="center">

**[⬆ 回到顶部](#sparkle-qwen27b-kvmem-ninfer)** · [下载 v1.2.0](https://github.com/CSUNX233/Sparkle-Qwen27b-Kvmem-ninfer/releases/tag/v1.2.0) · [提交 Issue](https://github.com/CSUNX233/Sparkle-Qwen27b-Kvmem-ninfer/issues)

</div>
