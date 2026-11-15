# 双路 compact 正确性与质量预算修复

2026-11-15，研究分支 `codex/kvmem-dual-lane`。本轮修复审查发现的三个问题；默认开关、日常引擎、模型、量化、采样和本机 CPU 视觉配置未更改。本说明不等于 16GB 部署验收。

## 本次保存状态

用户要求跑完最终实测后收口。保留最终候选 `14e97b700b25957d3caf636bc48a43f7b399fce8f9cec1f4550ecd4a1adc8ce9`，未安装日常，未提交/推送。

最终候选四项选择/页表/回收/Host压力测试及MTP全量整数oracle通过；110171-token回归严格12/12、stop、763输出tokens（649思考tokens），原4096上限未调整；218K回归26/26、stop、1,081输出tokens。最终候选的双路 40K×2（pool 32768、MTP3 eager）两路都召回自己的 code、`rows=2`，峰值11,250 MiB；forced continuation 控制命中、40,982 prompt、答案 `ZQ-7391`、stop；tool continuation `read_file` → `ZQ-4242`、stop，日常引擎哈希未变。证据见 [最终保存记录](../benchmarks/evidence/kvmem-dual-lane-20261114/verification-compact-fixes.json)。

源码快照与清理清单位于维护目录 `D:/34229/research/kvmem-dual-lane-20261114/checkpoint-20261115/`；保留当前候选、必要构建对象/脚本和报告，清理失败/重复EXE及临时缓存。

## 改动

1. **MTP pending 跨页**：选择集必须包含完整的连续待写页后缀，旧 partial tail 不能因为变成中间页而被丢弃。`publish_compact_view()` 从逻辑末端推导 pending 起点，检查后缀无缺页，并逐页验证 pending 前的可见列已提交。支持合法的跨页写入，不再仅检查末页。
2. **恢复两张逻辑表**：每次 compact 切到 prefill/forced continuation，text 和实际使用的 MTP/backend 都恢复逻辑执行表。无须扩页、trim 清除了 compact 标志时也照常恢复。
3. **保持独立质量预算**：`NINFER_KV_WINDOW` 仍表示 recent 历史预算。compact 保留 sink + 最近已提交历史 + retrieval，并额外保留 pending；重叠页去重。去掉 compact 专有路径的 `pool/4` 检索裁剪。所需页恢复失败或容量不足时明确失败，不能静默减少可见集合。

仅满足必需集合仍不足以等价原mask：原mask也能看见池中额外驻留的历史。最终选择在保住必需集合后，利用每路已有池内的剩余容量，从新到旧补齐已驻留、完整提交的页；text/backend共同前缀仍对齐，MTP必要时恢复对应Host页。不扩大Device池，但可能增加MTP搬运。私有审计分别保留逻辑/compact的实际页集合，避免只比较页数。

预算修复也需要落实到物理占用：auto sizing 和显式池检查计入全部质量预算、最坏起始偏移的 pending/prefill chunk，以及每路8页周转空间。多路映射时本路回收自己的冷页，使第一条长请求不能把整个物理池留满。compact decode的所选页作为硬保护；共享 ACTIVE 页不能释放另一条路的引用。Host 满时仍先尝试现有的冗余 Host 副本回收，再判断失败。

预填充保留原来的resident选择与两遍回收策略，只增加必要的双表逻辑恢复及多路配额约束。初版尝试在预填充也强制恢复整个recent集合，改变了计算轨迹；该增量已撤回。这里的强预算检查用于decode可见集合及池规划，不能宣称每个prefill token都获得了不同于legacy的新窗口保证。

在110K夹具中，撤回预填充增量本身没有改善失败；补齐已驻留页后，第五版恢复严格12/12、stop、763输出tokens。不能将该恢复错误归因于预填充撤回，也不能将第五版的结果自动转记到后续最终候选；最终候选另行完成218K 26/26。

非 compact 路径保留旧选择和回收策略。模型权重、KV量化和目标采样规则保持不变；下述MTP坐标修复会纠正草稿输入位置。

### 长文验收发现的 MTP 逻辑位置推进错误

初版修复候选在110K回归中耗尽4096输出额度，没有给出答案，不能验收。进一步审查发现：target验收会就地推进cache frontier，而独立的logical ingress保留轮前base；下一轮AR RoPE和context ceiling错误使用了旧base，没有加本轮licensed token数，compact关闭时也受影响。

逻辑上的正确结果为 `logical_after = logical_base + licensed_counts`。同步修复 `test_mtp_round.cpp` 的新接口参数，并补cache/logical不同、零/部分/全draft接受、上下文边界的整数oracle。旧CUDA候选在新oracle上失败，重编MTP launcher后全量oracle通过。

进一步发现acceptance使用frontier作为随机数绝对位置，因此不能把compact cache位置传给sampler，否则长生成会重复位置键。最终让acceptance使用logical BASE并原地推进至logical AFTER；下一轮kernel使用cache BASE+licensed计算cache位置，直接用logical AFTER计算RoPE和context ceiling。复用已有两个张量，不改变SamplingConfig ABI或增加workspace。温度0的坐标运算与前一修复版等价，非零温度的采样位置恢复为原逻辑坐标。

## 16GB 预算方向

在逻辑上下文远大于工作集的 ring 配置中，每路 Main 页的保守上界：

`sink_pages + max(recent_pages, 1) + retrieval_pages + pending_span_pages + 8`

`pending_span_pages = ceil((max(prefill_chunk, verify_width) + 63) / 64)`。

以维护者进阶预算 sink=12288、recent=19456、retrieve=6144、prefill128、MTP3/ngram15 为例，每路603页，两路至少1206页，即77184 Main KV tokens。研究时可从两份39168的池（78336）核算；这只是 Main 池规划，不是整卡显存结论。MTP 池、两路状态、Graph、视觉、Host KV/索引还需独立检查。公开保守配置的检索预算不同，应按实际配置计算。

容量不足时保留预算，选择排队或降低同时活动路数。不要通过把 recent 当总窗口、关闭生成历史索引或缩减检索来声称质量不变。当前仍要求显式研究开关。

## 验证

- 新增无 GPU 的 `ninfer_qwen3_5_kvmem_compact_selection_test`：64种起点偏移 × 1～64列宽度的独立坐标 oracle；对0/部分/全部接受前缀重建下一轮选择；完整预算、重叠去重、容量少一页拒绝与整数溢出。
- 扩充 `ninfer_qwen3_5_kvmem_compact_view_test`：实际 Device 表上的跨页 pending；漏 pending 起始页与历史 partial 页必须拒绝；无扩页恢复逻辑表。新增拒绝用例在旧 store 实现上失败，修复后通过。
- 扩充 `ninfer_qwen3_5_ring_demote_test`：硬保护不能回收所选页，legacy 两遍 fallback 保留；增加两个 ACTIVE 地址共享前缀时的引用保护。
- 模型回归已完成：最终候选 110K 严格12/12、218K 26/26、双路40K×2、forced 与 tool continuation 均通过；完整字段与峰值以 `benchmarks/evidence/kvmem-dual-lane-20261114/verification-compact-fixes.json` 为准。

本机只有12GB：较小预算的双路功能测试不能替代16GB全预算验收。最终仍需在目标机器测双路全预算、MTP+Graph与GPU视觉；本机已有110K/218K质量回归作为前置证据。

## 仍未完成

- 双路 accepted-only decode indexing 仍有单lane门禁；本轮未以关闭它冒充完整的长Agent质量验收。
- GPU视觉仍有门禁；本机CPU视觉不改。
- 双路256K的完整Host准入及16GB实际峰值、MTP/prefill取消和复杂工具循环尚需对应测试。
- 本机沿用隔离Host增量构建，发布前需要干净构建；本轮不替换日常或发布附件。
