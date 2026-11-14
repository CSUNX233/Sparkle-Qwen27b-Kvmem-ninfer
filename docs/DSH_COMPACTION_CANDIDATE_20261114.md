# DSH 长任务与状态卡源码更新（2026-11-14，尚未发行新 Release）

长视觉任务出现重复观察、编辑失败及摘要请求后历史未缩短的反馈。未取得故障电脑原始session，因此尚不能确定具体的摘要提交错误或HTTP499断开方。引擎done不等于DSH已提交摘要，cache_guard的rewrite日志也不等于它主动重写请求。当前安装器的stream idle timeout为30分钟，不能由128秒后的499推断统一两分钟超时。

源码和隔离夹具确认：除COMPACTION_INCOMPLETE外，多数自动压缩错误只警告并继续发请求。候选对ninfer-local自动压缩的其余异常改为抛出COMPACTION_FAILED，保留原因并停止当前轮；已取消则传播取消。保留原始事件及已提交checkpoint，不回滚或删除历史。其他provider保留现有策略。此修复防止错误后继续请求，不代表修好了所有导致摘要失败的因素，也不会阻止用户以后主动重试。

状态卡候选：

- 工具结果先收集，下一次允许进入的step最多注入一张。
- 成功edit/write累计8次才发普通检查点；8个文件各改一行，无论同批还是跨step，只有一张。第8次之前的普通操作无需卡片；工具原始结果仍保留。
- 新失败在下一步合并提醒；相同工具、参数和错误指纹在当前用户指令下不重复提醒。保留最多64个指纹，长时间后被淘汰的错误可再次提醒。
- 成功read/shell不周期性注入；源码里出现TypeError等单词不再被误认为执行失败，以实际错误标志为准。
- 编辑片段不当作整文件快照；新用户指令更新目标并清理旧失败；保持卡片为合法JSON且不超过1900字符。
- 保留图片会话不注入、计划保护及取消/拒绝保护。状态卡仍只是给模型的辅助上下文，不是防循环断路器；重复调用提醒也没有强制阻断语义循环的能力。

验证：state-card、compaction-fallback及tool-grounded-execution共28项确定性测试通过。包括8文件合并、跨步合并、重复失败、多个错误合并、目标更新、同文件后续批次、媒体/计划/取消、下游拒绝、JSON完整性、五种压缩异常阻止续跑。未启动GPU、未运行原始故障任务、未在5060Ti电脑测试、未改日常安装配置；本次仅更新GitHub源码，不发行新引擎附件。本轮没有改变量化、采样、视觉CPU/GPU、页池或Host KV预算。

验证命令：

```powershell
node --test integrations/dsh/local-agent/tests/state-card.test.mjs integrations/tests/compaction-fallback.test.mjs integrations/tests/tool-grounded-execution.test.mjs
```

下一步取证应读取故障会话的compaction/start、compaction/summary、compaction/end.error，核实摘要终止方式、提交错误及替换后的surface。不要公开原始对话、摘要正文或登录信息。仅替换引擎exe不会更新这些DSH模块。
