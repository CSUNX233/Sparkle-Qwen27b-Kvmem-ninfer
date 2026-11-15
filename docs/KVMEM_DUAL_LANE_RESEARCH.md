# KVMem 双路实验分支

日期：2026-11-14。分支：`codex/kvmem-dual-lane`，起点 `2d86b7a0e18f96f3f7b4a191f74797f04fc503eb`。这是双并发研究的第一阶段，不是可开启双并发的发行版。日常启动、模型、采样、页池及视觉配置没有切换；单路门禁保留。

## 上游核对

研究固定以下来源，不把最新主仓代码直接替换已验证的引擎：

| 来源 | 固定版本 | 用途 |
| --- | --- | --- |
| [KVMem](https://github.com/kvmem/kvmem/tree/0d7b4688f1e08b0334b67c2baf31a9160ed1ac98) | `0d7b4688f1e08b0334b67c2baf31a9160ed1ac98` | 读取公共内存契约、并发说明及 NInfer 集成补丁 |
| [KVMem 固定的 NInfer 底座](https://github.com/iamwavecut/ninfer-all/tree/6cc1f9fa438b7094685ae417dfa40e1ca324e617) | `6cc1f9fa438b7094685ae417dfa40e1ca324e617` | 在隔离源码中检查并应用相关 Program/runtime 补丁以研究实际实现 |
| NInfer 查询时的 HEAD | `40d913db2e87e2211fce4089c0c7920480a5e7a0` | 仅记录最新版本；本轮未升级到此版本 |

KVMem 的 `backends/patches/ninfer-kvmem.patch` 为 1,505,855 字节，SHA-256 为 `1a7037cd3131cb28c12ceb598fb540b79482a97f7135e7ef721480d3f7bbc954`。所选 Program/runtime/EngineOptions hunks 在其固定 NInfer 底座通过 apply-check；这不是整个补丁链或整个上游构建的验证。在本项目中，以 `--directory=engine` 检查其 `program_impl.h` hunk 会失败，不能照搬。

## 上游方法和当前差异

上游不是多开一套模型。权重由引擎共享；`SequenceState::window` 包含独立的 `KvmemWindowState`，其中包含逻辑页映射、Host archive、页版本、Mean-K statistics、selector、Query、feedback、checkpoint 和待完成的内存事务。原生 KV 的数据和 scale 按原字节搬运，递归状态仍由原生 StateImage 管理。

其 `WindowMemoryBackend` 绑定当前 sequence，而非裸全局缓存；批量解码逐行使用紧凑缓存位置与原逻辑 RoPE 位置，完成后只提交各路已接受候选的统计。规划按每路 B+R 计算 Main 工作集，并配套 MTP、递归状态、scratch 和 Host 共享预算。取消/失败释放本请求的事务及预留，不能清理另一请求的页或源快照。

本项目已有 **Program 所有的** harvest/index/probe，并通过 thread-local 指针绑定；并非所有状态都是不可分割的进程全局对象。真正缺的是活跃序列之间的完整隔离、批量行收割和跨路页回收。`thread_local` 只能隔离CPU线程，不能区分同一执行线程交错提交的两个GPU请求。现有 CUDA Graph 也不能靠改一次 thread-local 指针就自动改掉已捕获的设备地址。

此外，Attention 的 `KvmemHook` 当前只携带一组 harvest/layer/token 描述；需要按批量行携带来源。现有 ring 的取页上限还使用全池 `pool / 4`，直接把全池乘2会改变单路召回预算，不能将其当作预算不变的双并发。借鉴上游时必须将每路窗口、全局物理容量和保留快照额度分别计量。

上游同时切换了 Query/Pressure、图召回和窗口策略；直接移植整个桥会改变本项目的 `related-tool-head`、跨块 Query 组装、tail refresh 和前邻页策略。本分支先保留这些策略和原有算术路径。

## 本轮实际适配

新增 `engine/src/ops/kvmem/retrieval_workspace.h`，将现有 harvest、index 和 Query/score probe 封装为一个不可复制、不可移动的执行工作区，整体绑定三项状态。Program、decode 提交、MTP 提交、快照保存/恢复和 ring 读取使用该对象。

没有新增第二个产品 lane；单路仍只创建一个工作区，按原路径懒分配。保留原成员顺序。释放非当前工作区不解除另一工作区的绑定，释放当前工作区清除其绑定。调用者仍需先完成在途执行；该封装不提供自动取消或跨线程同步。

绑定还要求在同一执行线程上整体操作这三项，解绑后才能把对象交给其他线程销毁。对象不可移动不等于线程安全；在其他线程析构不会清除原线程的thread-local指针。旧Op验证器提供的逐项bind接口也不能在产品工作区生效期间混用。这两项是本轮接口约束，尚未做成跨线程自动管理；后续不能绕过这些约束直接启用多lane。

新增 GPU 测试 `engine/tests/ops/test_kvmem_workspace.cpp`，注册为 `ninfer_kvmem_workspace_test`。测试使用两套真实索引/harvest和两个CUDA stream，交替提交62次索引追加；独立验证所有F32 sums/counts（包括未写页和跨页尾块），并检查Query、generation、kept选择状态及释放非当前对象后的另一对象。该测试没有验证完整模型的同时解码，也没有证明两个stream的GPU工作在时间上必然重叠。

## 第二阶段：每路检索上下文

本轮把检索状态从“Program 一份”推进到“每 lane 一份”，对应“必须继续”第 1 项；启动门禁、日常引擎和启动参数仍未改。

- `ProgramImpl` 为每条 lane 持有一个 `RetrievalWorkspace`（mean-K index + Query/score probe）。构造函数一次性创建空上下文，index/probe 的 CUDA 与 pinned Host 分配仍在首次使用时懒分配，单路分配形态不变。
- raw-K staging **有意保持 Program 唯一**：decode CUDA Graph 捕获的是 staging 设备地址，一张图服务所有 lane。`RetrievalWorkspace::bind_with_harvest()` 让每路 index/probe 借用同一个 staging owner；批量解码时每路用 `MeanKIndex::append_committed_slice(row_offset, ...)` 只消费自己那一行（`row_offset` 为该行在扁平 staging 中的 token 偏移）。
- `bind_sequence_kv()`、`ensure_sequence_kv_mapped()`、`capture_retrieval(lane)`、`restore_retrieval(lane, ...)` 全部按 `SequenceState::lane` 绑定。快照仍存于 `sequence.retrieval`，续接即使换 lane 也先恢复到目标 lane 的 index。
- 这三个绑定点仍是 thread-local，且必须与执行在同一线程完成；本阶段没有新增跨线程自动管理，也没有解除单路门禁。

新增 GPU 测试 `engine/tests/ops/test_kvmem_lane_workspace.cpp`（注册 `ninfer_kvmem_lane_workspace_test`）：两个 lane 的 index/probe 共用一个 staging owner，lane A 取 row 0、lane B 取 row 1，用独立常量 BF16 oracle 精确核对所有 F32 sums/counts；检查 Query/generation/kept 跨 rebind 隔离、越界 slice 拒绝后两路 index 均不变、销毁非当前 lane 不解除当前绑定。它**没有**运行两个模型请求、两张捕获图或两个重叠 kernel。

同时注册了既有的 `test_kvmem_batch_commit.cpp`（`ninfer_kvmem_batch_commit_test`）：共享 harvest 被两个独立 index 按 row slice 消费，覆盖零提交、重放不重复计数、64-token 页跨界和几何拒绝。

12 次 GPU 运行（4 个用例 × Host=0/1、prefetch=0/1 的三种有效组合）全部通过。短 smoke 使用日常单路 CPU 视觉配置（`NINFER_KV_WINDOW=19456`、`NINFER_KVMEM_INDEX_DECODE=1`），基线 `f9a6…` 与候选 `471e…` 的短回复、缓存续接、视觉分块前 16 token 及 prompt token 数一致，两臂峰值均 11,234 MiB；日常引擎、`settings.yaml` 与启动脚本未改。证据见 `benchmarks/evidence/kvmem-dual-lane-20261114/verification-lane-workspaces.json`，第一阶段的记录仍在同目录 `verification.json`。

## 第三阶段：上游核对与 compact execution view 原语

核对固定上游后发现，双并发的正确形态不是“全局 mask + 每路索引”，而是：

- **KVMem 本体**（llama.cpp 后端）：`--parallel P` 创建 P 个独立 target context/lane，每个 lane 自己的 KV working set、recurrent buffers 和 MTP follower，不是共享 batch。
- **KVMem 固定的 NInfer 底座**：单个 Program 内每个 sequence 一套紧凑执行视图。`KvmemWindowState::pages` 把 compact 槽位映射回原始逻辑页；`compact_position(logical) = logical - removed_tokens`；retrieval swap 时 `destructive_truncate(text,0)` → `ensure_mapped_to_tokens(compact_end)` → 搬入 selected 页 → `commit_frontier(visible_tokens)`（`storage/kvmem_window.cpp`）。attention 读连续紧凑前缀，RoPE 仍是原始逻辑位置。物理页按 `kvmem_window_tokens/64 * max_concurrency` 分给各 lane。

也就是说，我们原型的 `PagedKVCache::install_selection()` 全局 mask 是本地捷径，正是双 lane 的根因。本阶段先做两个 store 原语，产品路径未改：

1. `KVAddressSpaceStore::rebuild_compact()`：按上游语义把 ACTIVE 地址重建成 selected 页的紧凑视图。与上游不同的是**不搬 KV 字节**：只重指成员引用并重发布执行表；非选中且无其他 owner/pin/Host 复制的页会被回收。首版限制 selected 必须是当前地址成员；把 archive 页拉回来是后续的 restore 步骤。
2. `KVAddressSpaceStore::publish_compact_view()`：只重发布执行表，逻辑地址、frontier、checkpoint protection 都不动。这是本分支的适配点：上游有完整 host archive 可以做破坏式 truncate；我们没有，所以先保留逻辑映射，让 checkpoint/prefix reuse 继续持有页，ring 的 demote/restore 继续管 residency。attention 语义与上游 `ExecutionView` 相同（dense compact_start + visible_tokens），只是地址簿记不破坏。

新增 GPU 测试 `engine/tests/models/qwen3_5/test_kvmem_compact_view.cpp`（注册 `ninfer_qwen3_5_kvmem_compact_view_test`），在同一 12 页池上验证：compact 槽位顺序、table row 重指向、partial tail、非选中独立页回收、重建后继续增长，以及非破坏发布不改变逻辑成员/Device replica；四类非法输入（重复页、零 token 尾、超宽 frontier、非本地址页）全部拒绝。测试还确认了一个必须写进接线的约束：**partial 页只能是 compact 视图的最后一页**，中间页必须已提交满 64 列，否则后续 compact 位置会落回 partial 页的未提交列。

本阶段只完成原语和测试，`NINFER_KV_COMPACT` 尚未接入 `ensure_sequence_kv_mapped`，日常引擎仍走原 mask 路径。

## 第四阶段：单路 decode compaction 接线

`NINFER_KV_COMPACT=1` 已接入，**默认关闭**，且启动门禁把它限制在单路普通 decode：要求 KVMem 检索、`--max-concurrency 1`、`SpeculativeBackend::None`、无视觉、`--no-cuda-graph`。不满足时直接拒绝，不会静默退回 mask 路径。

- **decode**：`ensure_sequence_kv_mapped(..., decode_round=true)` 先按原有 ring 逻辑 map/demote/restore，再构造 selected 集：sink + retrieval + 最新页，容量为 `min(NINFER_KV_WINDOW, pool) - slack`，且**最后一个必须是当前 partial tail**；非 tail 页必须已提交满 64 列。随后 `publish_compact_view` 发布 dense 行，装全 1 mask。`cache_positions` 用 `compact_position(frontier)`，`rope_positions`/`sample_positions` 仍是逻辑值，attention envelope 改成 compact 上界。
- **prefill/restore**：仍走逻辑行 + resident mask。compact 模式下每次非 decode 映射都先 `publish_logical_view`，只发布 **Device-resident runs** 恢复逻辑槽位（Host-demoted 页没有物理页可写，由 mask 隐藏），再 restore + 装 mask；不依赖 `compact_view_valid` 标志，因此 trim 清标志后设备上的 compact 行也不会被 prefill 误用。这样 checkpoint、prefix reuse 和 ring 的地址簿记完全不动。
- **失效**：`trim_sequence_kv` 和 `ordered_reset` 清空 compact 状态；任何 prefill 调用都会在需要时恢复逻辑行。

实测（候选 `f3770216…`，单路、无 MTP/DFlash、无视觉、无 CUDA Graph）：

| 用例 | 条件 | 结果 |
| --- | --- | --- |
| 无压力长文 | window 32768，prompt 20,242 | 短回复/缓存续接两臂逐字相同；长文输出两臂相同且都含 needle；峰值 10,772/10,772 MiB |
| 压力长文 | window 19456，prompt 40,942（needle 在 sink 与最新窗口之间） | 短回复相同；needle 在两臂都被召回；长文 8-token 输出两臂相同；无 `lost its tail`；峰值 10,774/10,770 MiB |
| 日常配置，compact 关闭 | `p0_rk4v4_daily` + MTP3 + CPU 视觉 | 短回复、缓存续接、视觉边界前 16 token、prompt token 数全部与日常 `f9a6…` 一致；峰值 11,238/11,234 MiB；日常引擎/启动/配置未改 |

压力用例里两臂输出相同是一个正向信号，但它不证明两臂的可见页集合相同；needle 召回才是这一轮的判据。`verification-compact-decode.json` 记录原始结果。

## 第五阶段：双 lane 与 batch compact decode

按上游“每 sequence 一套 dense 视图、物理窗口按 lane 分摊”的方式，把 compact 扩到两条普通 lane：

- 启动门禁在 `NINFER_KV_COMPACT=1` 下允许 `--max-concurrency 2`，ring 的“只能一条 active sequence”检查同步放行；decode indexing 仍要求单 lane，双路用例不设 `NINFER_KVMEM_INDEX_DECODE`。MTP/DFlash、视觉仍被拒绝（CUDA Graph 在第六阶段放开）。
- 两条 lane 的 `ensure_sequence_kv_mapped(decode_round=true)` 各自构造 sink + retrieval + 最新页，各自发布 compact 行；共享 cache 的 mask 装成**覆盖完整逻辑 span 的全 1**，不再依赖单 lane 的前缀长度。batch 的 attention envelope 取两行 compact 前缀的 min/max。
- 每条 lane 只回收自己的页：ring 的 `demote_other_addresses_to_host` 仍跳过 ACTIVE 地址；池按 `window × lanes` 规模（测试用 `--kv-capacity 40960`，窗口 19456/8192），两条 lane 的 selected 集分别落在各自窗口内。

实测（batch 行候选 `4cb99db1…`；40K 与 dense 对照在加 per-lane cap 前的 `0d34353f…` 上，cap 对测试窗口不生效）：

| 用例 | 条件 | 结果 |
| --- | --- | --- |
| 两条 40,946-token lane | window 19456，8-token 输出 | 串行与并发两臂逐字相同，各自召回 `ZQ-7391`/`ZQ-8246`；没有出现 `compact batch decode`（8 token 在第二条 prefill 完成前已结束）；峰值 10,950 MiB |
| 强制 batch 重叠 | window 8192，prompt 10,108，约 1,100-token 长输出 | 出现 `[kvmem] compact batch decode rows=2`；两条请求都完成、输出连贯、各自含自己的 code；无 `lost its tail`；峰值 10,982 MiB |
| dense 对照 | 同 prompt，`--max-context 12288 --kv-capacity 24576`，无 ring/KVMem/compact，max-concurrency 2 | 同样出现 batch-vs-serial 非逐字一致；共同前缀 A 750 / B 64 字符，compact 臂为 868 / 48；说明这是引擎 batch size 的数值效应，不是 compact 引入的 |

**边界**：batch 与单 lane 的输出不是逐字一致（dense 对照同样如此）；本轮没有构造“池子紧到必须回收另一条 active lane 页”的场景，也没有在 compact 下验证 MTP、视觉、取消一路或工具续接；CUDA Graph 见第六阶段。`verification-compact-dual.json` 记录原始结果。

## 第六阶段：compact + CUDA Graph

`use_cuda_graph` 已从 compact 的拒绝条件中移除。graph 在启动时按 batch size 捕获一次；compact 只改变 replay 前的执行表内容与每行 cache position，不动捕获到的行/掩码地址。单路压力与双路 batch 都已验证：

| 用例 | 条件 | 结果 |
| --- | --- | --- |
| 单路 graph 压力 | window 19456，prompt 40,942，graph 开启 | mask/compact 两臂短回复相同；长文都召回 needle 且 8-token 输出相同；峰值 10,772/10,774 MiB；compact 臂 decode 47.8 tok/s（eager 约 41–42） |
| 双路 graph batch | window 8192，prompt 10,108，约 1,100-token 长输出，graph 开启 | `compact batch decode rows=2`；两条都完成、各自含自己的 code；共同前缀 868/48、completion 1,060/1,139；无 `lost its tail`；峰值 10,956/10,986 MiB |
| 日常配置，compact 关闭 | `p0_rk4v4_daily` + MTP3 + CPU 视觉 | 与日常 `f9a6…` 逐项一致（该轮候选 `0d34353f…`；之后的 graph 门禁改动只作用于 compact） |

graph 重放证明：compact 的 cache position 是按行输入，kernel 的可见范围由 position 约束，而不是被捕获时的逻辑 envelope 撑大；否则压力用例会读到 compact 行之外的槽位。`verification-compact-graph.json` 记录原始结果。

## 第七阶段：紧池双 lane

为了确认“每条 lane 只回收自己的页”是否够用，把池压到 **16,384 token（256 页）**，两路各 10,108-token prompt、window 8192、sink 4096、retrieve 2048；per-lane cap = 128 页，selected = 120 页/路，两路共 240 页，只剩 16 页 slack。结果：

- `compact batch decode rows=2`；两条请求都完成、各自召回 `ZQ-7391`/`ZQ-8246`；无 `lost its tail`；峰值 10,534/10,566 MiB；串行/并发共同前缀 868/39 字符，batch 数值差异与 dense 对照一致。
- `demote-other short` 共 79 行，全部 `slots=0`：说明遍历时没有可降级的非 ACTIVE 地址（另一条 active lane 按设计被跳过），调用 lane 靠**自己的** demote 释放了页面，映射仍然成功。
- 结论：在“每 lane 窗口 ≤ pool/max_concurrency”的静态分摊下，两路紧池不需要跨 lane 回收；`demote-other short` 是诊断噪声，不是失败。跨 lane 回收“另一条 active lane 的已完整提交页”仍未实现，也没有被这个形状逼出来。

## 第八阶段：MTP compact

MTP 现在也走 compact，单 lane 的 eager 与 CUDA Graph、双 lane 的 eager batch 都验证过：

- `MtpDecodeIngress` 新增 `base_rope_frontiers`：`base_frontiers` 是 compact cache 位置，新数组保留原始逻辑 frontier，供 AR RoPE 和 context ceiling 使用。
- `mtp_prepare_next_round` 新增 `logical_frontiers`：`ar_positions` 继续用 compact 位置，`ar_rope_positions` 用逻辑位置；`context_extent` 也按逻辑 frontier 计算。
- 选择集为 MTP 预留 text tail 之后的连续页（draft window 最多 1–2 页），text 与 MTP 执行行发布成同一个对齐前缀；text compact 视图的 pending 改为本轮的 `extent + 1`，不再假设只有 1 个 decode token。
- MTP cache 的全局 mask 同样装成完整逻辑 span 的全 1；text/MTP 两张执行表各自 compact。

实测（候选 `11130258…`）：

| 用例 | 条件 | 结果 |
| --- | --- | --- |
| 单路 MTP 无压力 | window 32768，prompt 20,242，eager | 短回复/缓存续接/长文两臂逐字相同；MTP 6/6；无 tail 错误 |
| 单路 MTP 压力 | window 19456，prompt 40,942，eager | 短回复相同；长文都召回 needle 且 8-token 输出相同；MTP 6/6 |
| 单路 MTP + Graph | 同压力，graph 开，`--cuda-graph-allowance-mib 64` | 两臂输出相同、都召回 needle；MTP 6/6；decode 106.3 tok/s；不开 allowance 时 startup 要 1.86 GB runtime，12 GiB 卡放不下 |
| 双 lane MTP batch | max-concurrency 2、context 131072、pool 32768、window 8192、prompt 10,108、eager | `compact batch decode rows=2`；两条都完成、各自含自己的 code；MTP/ngram 混合投机正常；共同前缀 1,515/398、completion 1,114/1,264 |

**内存边界**：双 lane MTP + Graph 在 262K context 下需要 1.366 GB runtime，而 12 GiB 卡只有 1.151 GB 可用；eager 也要 1.299 GB。双路 MTP 需要更小的 context/pool 或更大的卡。紧凑的 131,072/32,768 eager 配置能跑。

## 第九阶段：视觉、取消、工具续接与 Host 准入

- **CPU 视觉 compact**：compact 门禁放开到 `--vision-cpu`（overlay/resident 仍拒绝）。日常 p0 配置（CPU 视觉 + MTP3 + CUDA Graph）下，候选 compact 与日常 `f9a6…` mask 的短回复、缓存续接、视觉边界前 16 token、prompt token 数全部一致；峰值 11,234/11,234 MiB。
- **取消一路**：双 lane、compact、Graph、131072/32768 配置下，A 在 18 s 关闭 SSE（服务端 HTTP 499 client disconnected），B 继续完成 1,207 tokens 并召回自己的 code；随后短请求 READY，无 worker crash。
- **工具续接**：`read_file` 工具调用 → 工具结果 → 第二请求，私有端点复用 846/905 tokens（93.5%），答案 `ZQ-4242`，MTP 27/30。
- **Host 准入**：`finalize_sequence_plan` 在 compact + 多 lane 时要求 `host_pages + pool_pages >= lanes * logical_pages`；compact 启动日志报告每 lane 的 Host index 预算（256K 上限约 256.2 MiB/lane，懒分配）。
- **双路 MTP+Graph 容量**：131K/32768 下 graph 需要 1.210 GB runtime（allowance 64）、1.277 GB（128）、2.716 GB（无 allowance），可用 1.151 GB → 放不下；eager 131K 双路 MTP 能跑。262K 双路 MTP eager/graph 分别需要 1.299/1.366 GB，也超过 1.151 GB。单路 MTP+Graph 用 allowance 64 在 262K 能跑。

边界：视觉只测了短/边界 prompt，没有测“图像 + 超过 window 的长文”；取消只测了普通 decode（未测 MTP/prefill 中途取消）；工具续接是固定 `read_file` 流程，不是多轮 agent 循环。

## 必须继续完成的环节

1. ~~将工作区与活跃 sequence/lane 关联…~~ 第二阶段已完成 index/probe 的每 lane 绑定，并由 `test_kvmem_lane_workspace` 验证；剩余约束是 thread-local 绑定必须在执行线程完成，无跨线程自动管理。
2. 按路收割 pre-RoPE K/Q 与已接受的 MTP 列；Graph 捕获、重放及取消必须使用正确的行和稳定地址。MTP compact 已通（第八阶段）；但批量解码的 harvest/index 仍未接线：`NINFER_KVMEM_INDEX_DECODE` 在双路下仍要求单 lane，`record_width × 行数` 的宽度校验仍待补。
3. 对原 ring 增加跨lane页所有权与回收约束、Main/MTP成对搬运和保留源快照；不能仅解除启动门禁。第五阶段已让两条 ordinary lane 各自用 compact 行、batch 重放跑通，且各自只回收自己的页；第七阶段在 256 页紧池下让两路各 120 页 selected 靠自己的 demote 跑通；跨 lane 回收另一条 **active** lane 的已完整提交页仍未实现，也没有被这个形状逼出来。MTP compact 已在第八阶段验证；仍缺 DFlash 下的 compact、取消一路时的页/行清理。CUDA Graph 已在第六阶段验证。
4. 在保持每路当前检索预算下重算双路GPU、递归状态和Host准入，再做真实双请求、取消一路、不同口令、工具续接、长输出及召回验证。两条 40,946-token lane 和一次 `rows=2` 的 10,108-token batch 已跑通；batch 与单 lane 输出不逐字一致（dense 对照同样如此），未验证取消、工具续接与更紧的 Host 准入。在 256K 上限下，两路各一份约 256.25 MiB 的 Host index 是新增固定成本；按实际配置的 context 计费后尚未纳入准入。

Host 预算也需单独准入：显存能放下两路工作集，并不代表原7GiB Host KV还能同时保留两条接近满256K的独立历史。本轮不自动扩大Host池或降低每路召回预算；不足时应排队或明确拒绝，而不是静默丢掉另一会话的数据。

“两条HTTP请求同时挂起”或“两套独立索引测试通过”均不是完整双并发。此前每路约39K、RK4V4、MTP3的额外1–2GiB是容量预估，不是本轮双路峰值实测，也不是保证。

构建与实测结果：第一阶段见 `benchmarks/evidence/kvmem-dual-lane-20261114/verification.json`，第二阶段见同目录 `verification-lane-workspaces.json`，compact 原语、单路 decode、双路/batch、graph、紧池、MTP 与视觉/取消/工具续接分别见 `verification-compact-view.json`、`verification-compact-decode.json`、`verification-compact-dual.json`、`verification-compact-graph.json`、`verification-compact-tight.json`、`verification-compact-mtp.json` 和 `verification-compact-vision-cancel-tool.json`。未完成或失败项必须按这些记录理解，不能把本说明当作并发已可用的承诺。

## 本轮实测结果

第一阶段候选引擎 SHA-256：`930e2d2639b99934976824fcf27744030af04615d3dc323a15dccb36239bc5cb`。重编71个Host和11个CUDA单元，保留经过哈希核对的其余静态依赖；不是干净全量构建。旧增量CUDA对象已被清理，首次链接因此被完整性检查阻止，随后重编11个CUDA单元，没有拿未知文件替代。两套GPU资格程序在Device、Host serial和Host prefetch三种条件下共6次运行通过；新增用例又以未预先设置KVMem启用环境变量的方式复测，默认CTest入口能自行启用夹具。

真实模型使用当前日常v1.2引擎作为基线，在5070Ti Laptop 12GB上串行运行两臂；没有在16GB电脑实测。重用旧110K/218K输入，其请求哈希与旧记录一致，两边按同一顺序执行，xhigh、seed42、原输出上限、RK4V4/GDN FP32、39168/6144、Host7GiB、MTP3和检索开关一致。常规与长文使用原纯文字Swift IQ3_XXS+MTP制品；CPU视觉边界是另一个对照组。没有把原始夹具、完整思考或私有日志放进公开证据。

| 检查 | 当前日常基线 | 本分支候选 | 判读 |
| --- | --- | --- | --- |
| 常规质量/工具选择8项 | 7/8 | 7/8 | 规范化输出一致；编辑题两边均先选择search/list_files，未达到旧评分要求的直接edit，不记成通过 |
| 86K多文件证据 | 通过 | 通过 | 六字段相同，规范化输出一致 |
| 110171-token旧退步用例 | 严格12/12，stop | 严格12/12，stop | 完整顺序及规范化输出一致，均763输出tokens，原4096额度未减 |
| 217899-token旧长文回归 | 26/26，stop | 26/26，stop | 按原评分；JSON与历史参考相同，键集合正确；两边逐字段字面相等均25/26，原评分对q10接受较长类名，不宣称26字段逐字相等 |
| 短回复、缓存续接、CPU视觉分块边界 | 通过 | 通过 | 三请求的message与输入token数一致；视觉只比前16生成tokens，不是通用识图质量测试 |

常规/多文件/两组长文共11项，规范化完整输出（包含思考，去除随机tool call ID）全部与基线一致。本轮固定seed条件下未观察到质量退步，不代表所有任务或真正双并发已无损。110K耗时329.562→272.047秒，218K耗时500.266→497.156秒；只有单轮对照、初始状态和系统负载会影响结果，不据此宣称普遍提速。每臂开始于新进程，但该臂各题连续运行；这不是每题独立冷启动的复刻。

显存分开记录：纯文字质量整轮峰值11351→11346MiB（0.5秒采样）；CPU视觉短测整轮峰值11447→11721MiB（1秒采样），其启动CUDA free为12→10MiB，固定runtime均1.06GiB、Host索引256.2MiB、评分scratch32MiB。后者增量尚未归因，不能用前者抵消并宣称严格零增量；整卡采样包含后台和加载效应，也不是瞬时上界。工作区封装没有引入第二份GPU工作区或扩大页池，但这不能代替显存实测。

测试后两臂退出，整卡占用均回到121MiB；测试端口18653/18654关闭。日常引擎仍为 `f9a6b29cb7755b18ae02dcc130c17b5e28b2c97530c647db9936680bd5c2ad46`，启动与配置未替换。完整模型双请求、跨lane页回收、双路Graph、双路长文与双路显存峰值仍未验证，当前分支不应作为双并发日常版安装。
