# KVMem 双路移植交接

日期：2026-11-15
分支：`codex/kvmem-dual-lane`（公开分支 `kvmem-dual-lane`），当前 HEAD `9480a0b`（v1.2.0 线）；以下阶段1–9结果保留各自基点
状态：工作区改动**未提交**；当前候选是隔离研究二进制，不是日常安装版
详细过程：[KVMEM_DUAL_LANE_RESEARCH.md](KVMEM_DUAL_LANE_RESEARCH.md)（阶段 1–9）
后续审查发现页边界、backend表恢复与窗口预算问题，已进入[第十阶段修复](KVMEM_DUAL_LANE_FIXES.md)。下面的历史候选哈希和测试结果不能替代本轮最终候选验收；旧的缩窗口命令不再代表保质配置。
第十阶段最终候选SHA `14e97b700b25957d3caf636bc48a43f7b399fce8f9cec1f4550ecd4a1adc8ce9`；四项页池测试、MTP整数oracle、110K严格12/12、218K 26/26、双路40K×2、forced continuation和tool continuation均通过。16GB全预算仍未验收。未替换日常；清理失败/重复候选后，以第十阶段保存记录查找当前二进制。
日常引擎：`f9a6b29cb7755b18ae02dcc130c17b5e28b2c97530c647db9936680bd5c2ad46`，未替换；启动脚本/`settings.yaml` 未改

## 0. 一句话

双 lane 的 KVMem 检索 + compact 执行视图已经跑通：1–2 路 ordinary/MTP、CUDA Graph、CPU 视觉、取消一路、固定工具续接；最终候选的 110K/218K 长文、双路 40K×2、forced continuation 和 tool continuation 均已通过。全部由 `NINFER_KV_COMPACT=1` 显式开启，默认关闭。剩下的主要是视觉长文/双路视觉、多轮工具循环、MTP/prefill 中途取消，以及双路 MTP+Graph 的显存容量。

## 1. 能力矩阵

| 能力 | 状态 | 备注 |
| --- | --- | --- |
| 单 lane ordinary compact | 完成 | 20K/40K prompt，含压力用例 |
| 单 lane 长文质量 | 完成 | v6：110K 严格12/12；218K 26/26；均 `stop` |
| 双 lane ordinary batch | 完成 | `compact batch decode rows=2`；两个 40K lane 也验证过 |
| 单 lane MTP compact | 完成 | eager 与 CUDA Graph；MTP 6/6 |
| 双 lane MTP batch | 完成（eager） | 131072 context / 32768 pool；`rows=2`；v6 双 40,958 prompt 均召回自己的 code，峰值 11,250 MiB |
| 双 lane MTP + Graph | **未通过容量** | 262K/131K 都超过 12 GiB 的可用 runtime；需要更大卡或更小上下文 |
| 单 lane ordinary Graph | 完成 | 40K prompt 压力通过 |
| 双 lane ordinary Graph | 完成 | 131K/262K 配置按显存选择 |
| CPU 视觉 compact | 完成（短/边界） | 日常 p0 配置逐项一致；未测“图像 + 超 window 长文” |
| Overlay/Resident 视觉 | 拒绝 | compact 门禁只放行 `--vision-cpu` |
| DFlash | 不做 | 按用户要求只保留 MTP |
| 取消一路（ordinary） | 完成 | A 被 HTTP 499；B 继续并召回自己的 code |
| 工具续接（固定 `read_file`） | 完成 | 私有端点复用 93.5%；v6 第二请求返回 `ZQ-4242`，日常引擎哈希未变 |
| Host KV 双路准入 | 完成 | `host+pool >= lanes*logical` 守卫 |
| Host index 预算提示 | 完成（日志） | 256K 上限约 256.2 MiB/lane；懒分配 |
| 跨 lane 回收另一条 ACTIVE lane | 未实现/未需要 | 静态 per-lane 窗口在 256 页紧池下足够 |
| batch 与单 lane 逐字等价 | 未证明 | dense 对照同样有差异；不是 compact 引入的 |

## 2. 开关与启动门禁

唯一开关：`NINFER_KV_COMPACT=1`（读取点 `engine/src/ops/kvmem/kvmem_score.h`）。

`ProgramImpl` 构造时要求：

- KVMem 检索已开启（`NINFER_KV_WINDOW` + 默认开启的 content scorer）；
- `--max-concurrency 1` 或 `2`；
- `SpeculativeBackend::None` 或 `Mtp`；DFlash/DFlash2 拒绝；
- 视觉只能是 `--vision-cpu`；overlay/resident 拒绝；
- generation Program（非 causal scoring）；
- CUDA Graph 允许；单 lane MTP+Graph 需要 `--cuda-graph-allowance-mib 64`。

其他已知门禁：

- `NINFER_KVMEM_INDEX_DECODE=1` 仍要求 `--max-concurrency 1`；双路用例不要设置它。prefill 的 index 照常构建。
- startup 的 ring 检查在 compact 下允许 `max_concurrency <= 2`；非 compact 仍要求 1。
- 第十阶段将 `NINFER_KV_WINDOW` 恢复为独立recent预算；每路需容纳sink+recent+retrieval+pending+8页周转空间，不足拒绝，不再将recent当整个selected上限。
- compact 启动日志会打印 `Host index budget: ... MiB/lane x lanes = ... MiB`。

阶段九验证过的单lane形态（MTP + Graph + CPU视觉）；第十阶段仍需对应复测，不作为安装日常的指令：

```powershell
$env:NINFER_KV_COMPACT = '1'
# 其余按日常 p0 配置；确保 --spec mtp、--cuda-graph-allowance-mib 64
```

双 lane 目前可用的形态（MTP 用 eager，不开 Graph）：

```powershell
$env:NINFER_KV_COMPACT = '1'
# --max-concurrency 2 --max-context 131072 --kv-capacity 32768
# --concurrent-prefill --spec mtp --draft-tokens 3 --no-cuda-graph
# 不设置 NINFER_KVMEM_INDEX_DECODE
# 双路 MTP+Graph 在本机 12 GiB 放不下，等更大卡/更小上下文再开 Graph
```

## 3. 代码地图

| 文件 | 作用 |
| --- | --- |
| `engine/src/ops/kvmem/retrieval_workspace.h` | 每 lane 的 index/probe 工作区；`bind_with_harvest()` 共享 raw-K staging |
| `engine/src/ops/kvmem/kvmem_score.h` | `kvmem_compact_enabled()` 唯一开关读取点 |
| `engine/src/models/qwen3_5/program/program_impl.h` | `retrieval_workspaces`、`retrieval_harvest_staging`、`SequenceState::compact_pages/compact_visible_tokens/compact_removed_tokens/compact_view_valid`、lane-aware 声明 |
| `engine/src/models/qwen3_5/program/program_impl.cpp` | 构造门禁、Host index 日志、析构解绑、`restore_retrieval(0,{})` |
| `engine/src/models/qwen3_5/program/storage/context.cpp` | lane-aware 绑定/快照、`compact_position`、`ensure_sequence_kv_mapped` 的 compact 分支（text + MTP）、full-ones mask、双路 Host guard 相关调用 |
| `engine/src/models/qwen3_5/program/storage/kv_store.h` | `rebuild_compact()`（上行地址压缩原语）、`publish_compact_view()`（非破坏执行表）、`publish_logical_view()`（resident runs） |
| `engine/src/models/qwen3_5/program/decode.cpp` | ordinary/MTP 的 cache position compact、RoPE 逻辑、batch envelope min/max、`decode_round=true` |
| `engine/src/models/qwen3_5/program/speculative/mtp.cpp` | MTP `base_rope_frontiers` 与 `mtp_prepare_next_round` 调用 |
| `engine/src/models/qwen3_5/program/round_buffers.h/.cpp` | `MtpDecodeIngress::base_rope_frontiers` 与状态张量 |
| `engine/include/ninfer/ops/mtp_round.h` + `ops/{wrapper,launcher,kernel}/mtp_round*` | `logical_frontiers` 参数；AR cache=compact、AR RoPE=逻辑 |
| `engine/src/models/qwen3_5/program/planning/startup.cpp` | compact 下 ring 允许 2 lane；Host KV 双路守卫 |
| `engine/src/ops/kvmem/mean_k_index.h/.cpp` | `append_committed_slice()`（已测，但批量 decode 的 harvest/index 产品路径仍未接线） |

测试：

- `engine/tests/ops/test_kvmem_workspace.cpp`
- `engine/tests/ops/test_kvmem_lane_workspace.cpp`
- `engine/tests/ops/test_kvmem_batch_commit.cpp`
- `engine/tests/models/qwen3_5/test_kvmem_compact_view.cpp`

## 4. 关键设计约束（改之前必读）

1. **pending必须是完整连续逻辑后缀**。后缀之前的可见列必须已提交；后缀内允许旧partial页位于新的tail之前。store必须逐页验证提交覆盖和pending无缺页，不能仅检查tail。
2. **选中集**保留完整sink/recent/retrieval以及连续pending，容量按per-lane share检查，tail必须存在且最后。text/MTP的共同页使用相同有序前缀，较长的一侧只追加连续尾页；不能为MTP尾页重复扣掉text可见预算。
3. **text pending = `main_tokens - sequence.text_kv_valid`**，不是固定 1。MTP 一轮会写 `extent + 1` 列；普通 decode 才是 1。backend pending = `backend_tokens - sequence.mtp_kv_valid`。
4. **compact 位置** `p - compact_removed_tokens` 对 text 和 MTP 都成立，因为 removed 只来自整页空洞；不要改成按 token 删。
5. **decode** 发布 compact 行 + 覆盖完整逻辑 span 的全 1 mask；**prefill/restore** 必须重发布逻辑行（只写 Device-resident runs），且不能只依赖 `compact_view_valid`：trim 会清标志，但设备上的 compact 行可能还在。实际实现是 compact 开启时每次非 decode 映射都无条件重发布。
6. `ensure_sequence_kv_mapped(..., decode_round=true)` 只给 decode 用；prefill/forced-token/materialization 必须 false。
7. `base_frontiers`（MTP ingress）是 compact cache 位置；`base_rope_frontiers` / `target_rope_positions` / `mtp_prepare_next_round.logical_frontiers` 是逻辑位置。`context_extent` 必须用逻辑 frontier。
8. **每条 lane 只回收自己的页**；`demote_other_addresses_to_host` 仍跳过 ACTIVE。per-lane share 保证两路 selected 装得下；不要去掉 per-lane cap，也不要在没有实现保护的情况下让一条 lane 回收另一条 active lane。
9. Graph 重放的可见范围由每行 cache position 约束；不要把 compact 行之外的旧槽位当成可读。MTP+Graph 的 driver-state 估算吃 `--cuda-graph-allowance-mib`；单 lane 用 64 可跑，双 lane 在 12 GiB 放不下。
10. 不要启用 DFlash/DFlash2 compact（未实现/未验证）；不要启用 overlay/resident 视觉。

## 5. 构建与测试

### 正常 CMake（推荐，可移植）

按 [docs/BUILD.md](BUILD.md) 的 Windows/CMake 流程配置 `BUILD_TESTING=ON`。新增测试已注册：

```powershell
cmake --build runtime/build --target ninfer_tests -j
ctest --test-dir runtime/build --output-on-failure -R "kvmem_(workspace|lane_workspace|batch_commit)|qwen3_5_kvmem_compact_view"
```

clean CMake 构建会正常编译 `mtp_round.cu`/wrapper，**不需要**下面的静态库覆盖。

### 本机增量研究构建（仅限这台 12 GiB 机器）

工程目录：`D:/34229/research/kvmem-dual-lane-20261114`
构建脚本：`build-mtp.py`（当前树；71 Host + MTP wrapper，11 个既有 CUDA 复用 + MTP launcher 重编）

```powershell
cd D:/34229/research/kvmem-dual-lane-20261114
python build-mtp.py
```

它依赖本机已有的旧构建树、`build-local.py`、MSVC 14.44/CUDA 13.0 工具链和 `tool-envelope-fix-20261109/build-manifest.json`，**不可移植**。新 MTP wrapper/launcher 对象会覆盖保留静态库里的旧实现；这不是干净全量构建。候选输出：

```
D:/34229/research/kvmem-dual-lane-20261114/build/ninfer-lane-workspace-candidate.exe
```

当前候选 SHA-256：`ae7ebadd06dd761b0ce0f132ecfc9062b1d9a98e4d781b227bd8a15825c4ffb8`

注意：`build-lane-workspace.py` 是 MTP 改动之前的脚本；当前树请用 `build-mtp.py`。`refresh-workspace-test.py` 用于单独重链 `test_kvmem_workspace`。

### smoke / 回归脚本（研究目录）

| 脚本 | 覆盖 |
| --- | --- |
| `compact-smoke.py` | 单路 compact vs mask，window 32768，无压力 |
| `compact-pressure-smoke.py` | 单路 40K > window，needle |
| `compact-pressure-graph-smoke.py` | 单路 + Graph |
| `compact-dual-smoke.py` | 两个 40K lane，串行 vs 并发 |
| `compact-batch-smoke.py` / `-graph-` | 双路 batch rows=2（ordinary） |
| `compact-tight-smoke.py` | 256 页紧池双路 |
| `compact-mtp-smoke.py` | 单路 MTP 无压力 |
| `compact-pressure-mtp-smoke.py` / `-graph-` | 单路 MTP 压力 / Graph |
| `compact-mtp-batch-smoke.py` | 双路 MTP batch eager（131K/32768） |
| `compact-mtp-batch-graph-smoke.py` | 双路 MTP+Graph（本机容量不足，记录用） |
| `vision-compact-smoke.py` | 日常 CPU 视觉 + MTP + Graph，compact vs 日常 mask |
| `cancel-smoke.py` | 双路 streaming，取消 A，B 完成 |
| `tool-continuation-smoke.py` | read_file → tool result → 答案 |
| `dense-batch-smoke.py` | 无 ring/KVMem 的 batch 数值对照 |
| `smoke-workspace.py` | 日常 config（MTP+CPU 视觉）候选 vs 日常引擎 |
| `long-quality-regression.py` | 历史 110K/218K/工具夹具（未在本轮 compact 下整套重跑） |

## 6. 关键验证结果

- 12/12 KVMem GPU 用例通过：4 个用例 × 三种 Host/prefetch 有效组合（host0/prefetch0、host1/prefetch0、host1/prefetch1）。
- 最终 v6：110K 严格 12/12、`stop`、763 输出 tokens；218K 26/26、`stop`、1,081 输出 tokens、487.4s，峰值 11,240 MiB。
- 最终 v6 双路：两条 40,958-token prompt、pool 32,768、MTP3 eager、`rows=2`；A/B 都召回自己的 code，峰值 11,250 MiB。
- 最终 v6 forced continuation：控制命中，40,982 prompt，答案 `ZQ-7391`，`stop`；tool continuation：`read_file` → `ZQ-4242`，`stop`，日常引擎未变。
- compact view store 用例：槽位顺序、table row、partial tail、非选中页回收、重建后增长、四类非法输入。
- 单路 ordinary：无压力 20,242 与压力 40,942（window 19456）两臂输出一致、needle 都召回。
- 单路 ordinary Graph：40,942 压力通过，compact 臂 decode 47.8 tok/s。
- 双路 ordinary：两个 40,946 lane 串行/并发逐字一致；10,108 batch `rows=2`，两代码都召回。
- 紧池：256 页、两路各 120 selected，`rows=2` 仍成功；79 条 `demote-other short` 全部 `slots=0`（只回收自己）。
- 单路 MTP：无压力/压力/Graph 都通过，MTP 6/6；Graph 106.3 tok/s。
- 双路 MTP eager：131K/32768，`rows=2`，两代码都召回，MTP/ngram 混合投机正常。
- CPU 视觉：日常 p0 配置短回复/缓存续接/视觉边界与日常 mask 逐项一致，峰值 11,234/11,234 MiB。
- 取消一路：A HTTP 499，B 1,207 tokens 并召回 code；之后短请求 READY，无 worker crash。
- 工具续接：`read_file` → 工具结果 → 第二请求 93.5% 私有端点复用，答案 `ZQ-4242`。
- 日常 compact-off：短回复/缓存续接/视觉边界/prompt tokens 与 `f9a6…` 一致。

证据索引（`benchmarks/evidence/kvmem-dual-lane-20261114/`）：

- `verification.json` — 阶段 1
- `verification-lane-workspaces.json` — 阶段 2
- `verification-compact-view.json` — compact 原语
- `verification-compact-decode.json` — 单路 decode
- `verification-compact-dual.json` — 双路/batch
- `verification-compact-graph.json` — Graph
- `verification-compact-tight.json` — 紧池
- `verification-compact-mtp.json` — MTP
- `verification-compact-vision-cancel-tool.json` — 视觉/取消/工具/Host

## 7. 已知边界 / 未完成

1. **双路 MTP+Graph 容量**：12 GiB 卡可用 runtime 1.151 GB；131K/32768 graph 需 1.210 GB（allowance 64），262K 需 1.366 GB；eager 131K 双路能跑，262K eager 也超。需要更大卡或更小 context/pool。
2. **视觉长文/双路视觉**：只测了短/边界 prompt；图像 + 超 window 长文、两个视觉 lane 未测。
3. **取消**：只测 ordinary decode 中途；MTP/prefill 中途取消未测。
4. **工具续接**：固定单 `read_file` 流程；多轮 agent 工具循环未测。
5. **跨 lane 回收**：未实现；当前静态 per-lane 窗口在 256 页紧池下够用。池紧到必须回收另一条 ACTIVE lane 的已完整提交页时没有方案。
6. **Host index 硬准入**：只打日志，没有按两路 index 总量做硬拒绝/排队。
7. **batch 数值等价**：batch 与单 lane 不逐字一致；dense 对照同样有差异，说明是引擎 batch size 的数值效应。质量口径是否需要对齐，需要你们定。
8. **性能**：只有单次观察（compact Graph 47.8/106.3 tok/s），没有系统基准；不要把这些数字当吞吐承诺。

## 8. 下一步建议（按优先级）

1. **双路部署形态**：v6 已在 12GB 上覆盖 218K、双 40K×2、forced 和 tool；下一步在目标 16GB 上测全预算（1,206 Main pages）与 MTP+Graph/视觉，再决定部署配置；不要直接切日常。
2. **视觉长文与双路视觉**：图像 + 40K 文本的 compact 压力；两个视觉 lane 的 CPU 视觉/索引隔离。
3. **MTP/prefill 中途取消**、多轮 agent 工具循环。
4. **Host index 硬准入**（如果两路 256K 是目标）：按 `mean_k_index_bytes * lanes` 加入启动/准入预算，不足时排队或明确拒绝。
5. **batch 数值等价**（如果质量口径要求逐字一致）：先确认 dense 对照的差异口径，再决定是否值得对齐。
6. 上述验收通过后，才考虑解除 `NINFER_KV_COMPACT` 的研究门禁并切换日常；切换前保留 `f9a6…` 回退。

## 9. 回退与隔离

- compact 默认关闭；不设置 `NINFER_KV_COMPACT` 时走原来的逻辑行 + resident mask。
- 日常引擎 `f9a6…`、`settings.yaml`、启动脚本都没有改；研究候选没有安装。
- 本分支改动**未提交**。换人/换机前先 `git status`/`git diff` 确认工作区；不要假设 HEAD 包含这些改动。
- 候选是增量链接产物（新 MTP 对象覆盖保留静态库），不是可发布构建；发布前必须做正常 CMake 干净构建并重跑测试。
