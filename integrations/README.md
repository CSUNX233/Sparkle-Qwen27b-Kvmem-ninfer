# dsh、搜索、浏览器与缓存续接

首次部署与排障先看 [部署与维护手册](../docs/DEPLOYMENT_AGENT_GUIDE.md)。DSH 固定为 `@deepseek-ai/dsh@0.1.5-rc.3`，依赖以 lockfile 为准；引擎、守卫、DSH 和工具须分开验收。

## 2026-11-15：撤除重复任务注入

已删除 `state-card`、`task-ledger`、`todo-completion` 本地模块和截图后的续作提醒，web profile 同时禁用原生 `repeat-tool-reminder`。这些插件虽然标记 `source.kind=plugin`，在 pi-ai 序列化后仍是普通 `role=user`；反复重述目标或要求继续，可能让模型把检查点理解成用户再次催改。当前不再提供重新启用状态卡的开关，旧 `StateCard` / `TaskLedger` 字段被忽略。历史实验报告保留，它们不能证明真实长任务不会退化。

`tool-grounded-execution` 只保留稳定的系统指导，不再监听截图或追加用户消息。`edit-guard` 保留工具执行前的精确替换校验及错误反馈；`tool-call-recovery` 保留畸形调用的非执行错误路径，连续四次格式错误停止当前轮。正常工具返回、用户消息、计划/审批机制及必要的压缩摘要继续使用。

源码安装在下次运行 `scripts/configure-dsh.mjs` 时清除旧 loader 项。仅修复现有 profile、保留模型配置时使用：

```powershell
node scripts/remove-dsh-reminders.mjs
# 独立旧安装示例（指定实际目录）：
node scripts/remove-dsh-reminders.mjs --home D:\AI\dsh\home --dsh D:\AI\dsh
```

迁移器备份原始 `cordis.patch.yml`，删除上述提醒及旧 `early-stop-recovery`，将执行指导指向本次无截图钩子的模块，保留其余插件。不要在正在执行任务时迁移。原会话中已经写入的提醒不会删除；停止后重新启动 DSH 才能保证旧进程中的回调全部卸载。恢复可复制备份 profile；同时保留其引用的旧模块。

## 配置与验证范围

`local-agent/initial-context-order.mjs` 修正新会话的检索查询来源：DSH 原先把技能目录等背景消息放在真实任务之后，pi-ai 又把它们全部编码为普通 `user`，使 NInfer 的“最后用户消息”查询落到技能目录。现在仅在 `ninfer-local` 首次接收纯文本任务时，将已识别的背景信息放在真实任务前面。原文、消息数量、工具和模型参数不变；顺序在首次落库前确定，后续请求沿用相同前缀，不改写已有会话。图片、计划模式、其他预设和未知来源保持原处理方式。

**该顺序修复保留为候选，默认关闭，当前不建议加入日常。** 显式设置 `"InitialContextOrder": true` 才会由配置生成器启用；已有安装也可用 `node scripts/remove-dsh-reminders.mjs --fix-query-origin` 明确试用，组合上面的 `--home` / `--dsh` 路径参数。该选项只更新 profile 和模块引用，不重写模型配置。已有会话不会重新排序，需要新会话才能试用首次顺序修复。

当前工作树已通过 49 项确定性检查，包括真实网页预设、原生 shell 工具及 HTTP 适配器的两步验证。实模请求也已确认“全部消息文本相同、其他请求字段相同、真实任务成为最后用户消息”。首轮输出由约 5.7 万变成 7.2 万 token，尚不能证明整体质量和速度受益；长测已按用户要求收尾，保留报告，不把查询来源正确等同于所有任务都会收敛。[结果与日常建议](../docs/DSH_QUERY_ORIGIN_20261115.md)

`configure-dsh.mjs` 面向本 checkout 的隔离 `runtime/dsh-home`，会生成模型路由等设置；只想撤除提醒时应使用上面的窄迁移器。当前最大输出 73728，压缩阈值约 184320；已有 preset 不自动覆盖。保留 xhigh、采样、视觉 CPU/GPU 选择、页池和 Host KV。

压缩失败时阻止继续发送未压缩的超长历史，保留原始事件和已经提交的 checkpoint。该保护仍保留，不能据此宣称摘要生成本身永不失败。未闭合工具壳后回落正文是独立的引擎解析问题；不把普通代码答案自动执行为工具。

```powershell
node --test integrations/tests/*.test.mjs integrations/dsh/local-agent/tests/*.test.mjs
```

确定性检查覆盖真实 Cordis 工具/提示流水线、实际 pi-ai 用户角色转换、迁移幂等性、配置保留、压缩失败及工具恢复。真实长任务对照另行记录，不把这些检查当成实模质量结论。

## 搜索、浏览器和守卫

`local-web/web-provider.mjs` 使用本机网络抓取公开页面；无付费 API，也不提供离线搜索。`browser-server.mjs` 通过本机 Edge 提供 MCP 浏览器工具。截图路径不是图像像素，更不等于视觉验收通过。驱动、代理和浏览器 GPU 偏好由用户控制。

`cache_guard.mjs` 保留等价消息及明确 pruner 裁剪标记的缓存恢复，预算上限 210000。真实编辑、压缩或换图需要重新计算相应前缀；守卫不是质量评分器，不能解决模型重复改写。客户端中途断连会关闭对应上游连接；正常完成不触发取消。

不安装女娲或人物技能。DSH 与派生 patch 保留 MIT 许可，新接入代码使用 Apache-2.0；见根目录 NOTICE 与 licenses。
