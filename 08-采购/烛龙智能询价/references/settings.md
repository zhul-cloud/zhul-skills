# settings.json 配置说明

技能根目录的 [settings.json](../settings.json) 只提供发布默认值；个人覆盖保存在 `<数据目录>/settings.json`，数据目录的完整系统路径及用途见[手册「数据目录」](../使用手册.md#6-数据目录)。运行时逐字段合并：个人有该键就用个人值，缺项继承当前技能默认值。升级按[数据生命周期](data-lifecycle.md)保留个人数据并处理旧格式，缺项继承新版默认。本文不另存默认值。

浏览器页面人助时限由 BrowserOS 控制，不属于本技能配置；等待与恢复细则见 [执行协议](execution.md#暂停与恢复)。配置键/值含糊、reset 缺目标或准备时配置非法，按[主代理提问与续跑](execution.md#何时提问答后回到哪里)对应分支处理。

## 查看和修改

用户可以自行修改个人配置，也可以让 AI 修改，聊天调用见[手册「配置」](../使用手册.md#配置)。请求分流与不启动询价的边界见 [SKILL.md「请求分流」](../SKILL.md#请求分流)。

AI 按以下流程处理，用户无需直接操作内部命令：

1. **查看或解释**：执行 `node "<技能目录>/scripts/settings.mjs"`，校验通过后展示全部配置项表格（键名、有效值、来源、中文说明），以及默认配置、个人配置和数据目录的绝对路径；校验失败不输出配置表，如实报告问题，不自行修复。只问参数效果或当前值时只读；检查请求执行 `node "<技能目录>/scripts/settings.mjs" check`，校验发布默认值、个人覆盖的格式与键名，以及合并后的有效配置。不运行 `init`，不创建数据目录或个人文件，不声称当前版本已初始化。
2. **设置配置值**：先明确具体项和值，含糊时才澄清，不替用户选值。已运行的询价须按 [SKILL.md「暂停、用户停止与失败边界」](../SKILL.md#暂停用户停止与失败边界)先结束或停止，并确认所有执行者已停；查看无须停止。随后先执行 `node "<技能目录>/scripts/records.mjs" init`，按[数据生命周期](data-lifecycle.md)报告保留或重建结果，再读取当前配置；保留的坏值按[校验边界](#校验边界)修复。只生成包含用户要求项的嵌套 JSON 补丁，写到数据目录以外的临时路径后执行 `node "<技能目录>/scripts/settings.mjs" set "<补丁.json>"`。保留其余个人覆盖，整批校验合并结果后原子写入个人文件，失败不改原文件。成功展示修改前后有效值、个人覆盖的新增/更新和路径；已有相同个人覆盖时报告「配置无变化，未重写文件」。例如「首轮每平台 2 家、跨平台目标 3 家、每平台累计最多 4 家」对应 `inquiryStrategy.initialShopsPerPlatform`、`inquiryStrategy.targetComparableQuotes`、`inquiryStrategy.maxShopsPerPlatform`；只修改用户指定项，合并后仍须满足首轮数量不大于累计上限。
3. **作用范围**：只写 `<数据目录>/settings.json` 中的指定覆盖，不把完整有效配置复制进去、不改仓库默认值或 AI 全局配置。同一电脑、同一系统用户下的客户端和技能副本共用个人覆盖，各副本仍读取自己的发布默认值。后续每次实际开始新询价都重新读取并检查有效配置，含同一会话后续启动，不用旧上下文中的值；不在进行中的询价里热改。当前不支持自动「仅本次临时覆盖」，用户只要求本次临时时不能擅自永久保存。
4. **自行编辑与继承**：先停止询价并按[数据生命周期](data-lifecycle.md)完成当前版本初始化，再编辑个人文件。文件使用嵌套对象，仅保留需要固定的已知字段；移除某个覆盖键即可恢复继承默认值，AI 操作见下文[恢复默认与继承](#恢复默认与继承)。显式设值即使等于当前默认，也保存为个人覆盖，固定该选择；只有已有同值覆盖才不重写。数组（如 `thankYouMessages`）整体替换，不逐项合并。`0`、`false` 和允许留空字段的空字符串都是有效的显式值，不当成缺项。个人文件和补丁均须使用 UTF-8 无 BOM 编码及合法 JSON 格式，JSON 不允许注释。改完用 `settings.mjs check` 检查，失败先处理配置问题，不开始业务。
5. **本机调整与发布**：个人调整不进入仓库，不要求升技能版本、改 CHANGELOG 或走 PR。维护者修改发布默认值按[采购修改规则](../../README.md#修改规则)同步受影响文档、版本与 [CHANGELOG.md](../CHANGELOG.md)；升级的数据处理见本文开头的生命周期规则。

例如，只固定首次人工回复等待时间时，个人 `settings.json` 可以仅包含：

```json
{ "firstHumanReplyMinutes": 8 }
```

其余字段无需复制，继续继承发布默认值。

### 恢复默认与继承

用户明确要求「恢复默认」或「恢复继承」时，用 `reset` 移除指定字段的个人覆盖，继续继承默认值，不把默认值写入个人文件。未指明目标按[提问分支](execution.md#何时提问答后回到哪里)澄清，不默认为全部。范围明确且执行者已停后，先按上文 `init` → 读取当前配置，再执行 reset；若涉及旧格式清理，应与 reset 本身的指定覆盖删除分别报告。

```bash
node "<技能目录>/scripts/settings.mjs" reset firstHumanReplyMinutes
node "<技能目录>/scripts/settings.mjs" reset inquiryStrategy.initialShopsPerPlatform inquiryStrategy.maxShopsPerPlatform
node "<技能目录>/scripts/settings.mjs" reset subagents.codex
node "<技能目录>/scripts/settings.mjs" reset --all
```

配置键使用已知点路径，也支持 `inquiryStrategy`、`subagents.codex` 等对象组；多个键整批移除、合并校验后一次写入。恢复策略指定项后仍须满足首轮数量不大于累计上限，冲突时原文件保留，可一次恢复相关项或整个组。`--all` 仅将个人 `settings.json` 清空为 `{}`，不动 ERP 地址、运行记录或其他数据。无参 `reset`、未知键、`--all` 与其他键混用都报错且不写入。`set` 不能删除键，显式设置为当前默认仍固定该选择，`null` 或 `{}` 也不是删除指令。

工具使用共享配置模块的写入锁、并发原文检查和原子写入；失败不改原文件。个人文件不存在或所有指定路径均不存在时不写入、不创建文件，已有 `{}` 时全部恢复也不重写；显式选中的空配置组仍会移除并保存，仅删除空组不改变有效值。成功后展示前后有效值、移除的个人覆盖和路径；执行 `settings.mjs check`，按需用无参命令展示恢复后的有效值和来源。校验失败如实报告，不启动询价；可修复范围见下文[校验边界](#校验边界)。

### 供 AI 读取有效配置

每次实际开始新询价时，按 [SKILL.md「准备」第 1、2 步](../SKILL.md#准备)先 `init`，再执行只读 `settings.mjs json`，重新校验并读取合并后的有效配置；派发平台子代理时传递本次读取的合并值，不重新读取或直接使用仓库默认文件。本机记录脚本也通过共享配置模块读取有效值。

## 校验边界

发布默认值须独立完整合法；个人配置允许缺项，合并后的有效配置仍须完整合法。只读检查及保留数据的操作中，个人文件不存在或为 `{}` 时继承默认值；文件存在但 JSON、编码、键名或有效值非法时直接报错，不静默回退默认值。工具拒绝合并结果缺少必填项、未知键、空补丁及非法类型或范围。用户明确要求时，`set` 可修复合法 JSON 中已知个人配置项的无效值；`reset` 可通过删除指定覆盖修复这类坏值或组合冲突。操作后的合并结果仍须完整通过校验，不能修复无效的发布默认值。个人文件的坏 JSON、BOM 等编码问题或未知键须先纠正，再检查；这些修复规则适用于保留的数据；仅生命周期协议规定的旧格式数据允许清理重建。

| 配置 | 允许值 |
|---|---|
| `confirmBeforeSend`、`subagents.enabled` | 布尔值 `true` / `false` |
| `inquiryStrategy.initialShopsPerPlatform`、`inquiryStrategy.targetComparableQuotes`、`inquiryStrategy.maxShopsPerPlatform` | 正整数，且首轮数量不大于每平台累计上限 |
| `maxFollowUpsPerShop` | 非负整数 |
| `dedupeDays`、`firstHumanReplyMinutes`、`followUpReplyMinutes` | 非负有限数；防重复设为 0 表示不防重复，等待设为 0 表示立即结束对应等待 |
| `pollIntervalSeconds.min`、`pollIntervalSeconds.max`、`subagents.stallMinutes` | 正有限数；轮询满足 `min <= max` |
| `priceOutlierPercent` | 0 到 100 的有限数（含边界） |
| `thankYouMessages` | 至少 3 个非空字符串 |
| `subagents.claude.model`、`subagents.codex.model` | 字符串，可留空；实际模型可用性以当前工具为准 |
| `subagents.claude.effort` | `low`、`medium`、`high`、`xhigh`、`max` 或空字符串 |
| `subagents.codex.effort` | `low`、`medium`、`high`、`xhigh`、`max`、`ultra` 或空字符串；所选模型支持范围仍需运行时核对 |

下文的建议范围是调优参考，不是校验硬上限。语法、类型与范围检查通过不代表模型或思考深度可用；AI 必须核对当前客户端实际工具支持情况，不可静默换模型或声称已生效。

## 各项说明

### confirmBeforeSend：发询价前是否先让用户确认

| 取值 | 效果 |
|---|---|
| `false` | **自主执行**。AI 挑好店直接发询价，不请求发送前确认 |
| `true` | AI 每轮按[发送确认分支](execution.md#何时提问答后回到哪里)汇总可继续平台的实际新店和完整话术，由主代理取得明确同意后再发；参与范围与故障等待边界以该分支为准，新店名单或话术变化需重新确认 |

- 只管「发询价」这一步，不改变共享的[暂停与恢复规则](execution.md#暂停与恢复)。

### inquiryStrategy：首轮、有效报价目标与补轮上限

- `initialShopsPerPlatform`：每个 ERP 明细在每个平台首轮联系的不同商家数。
- `targetComparableQuotes`：每个明细跨启用平台的有效可比报价商家目标；它不是 ERP 最多保存几条报价。
- `maxShopsPerPlatform`：该明细在每个平台累计联系的不同商家上限，包含之前轮次的进度；不是每轮重新取得的额度。
- 具体计数、可比证据、主体去重和停止新店规则统一见[有效可比报价与补轮](inquiry-rules.md#有效可比报价与补轮)。这些策略不改变店级计时、追问、截止或发送权限。
- 保留的个人旧组 `shopsPerItem` 或 `shopsPerLink` 只在读取时将旧 `max` 规范化为首轮数量；旧 `min` 不再有不足告警含义。目标和累计上限缺项继承当前发布默认，不能把旧 `max` 当成累计上限。只读及 `init` 都不改个人文件；下一次用户明确配置写入才按新组保存。两个旧组并存或新旧组并存均拒绝猜值。
- 发布默认、`set` 和 `reset` 只接受 `inquiryStrategy` 及其新字段。旧首轮值大于当前累计上限时报告冲突，由用户明确选择修复或恢复相关配置，不自动扩大上限或清空其他个人设置。

### firstHumanReplyMinutes：等首次人工回复的时间（分钟）

- 每家店从**发出询价**起等待首次人工回复的时长；机器人回复不重置计时。设为 0 表示立即结束这段等待。
- 超时、人工回复与机器人消息的判断见 [inquiry-rules.md「等待回复」](inquiry-rules.md#5-等待回复sop-第六章-q2)。等得更久可能收到更多回复，也会增加任务耗时。

### followUpReplyMinutes：追问或答复后等回答的时间（分钟）

- 每家店从**发出追问或答复**起等待回答的时长；设为 0 表示立即结束这段等待。超时后的记录见 [inquiry-rules.md「每家店的进展」](inquiry-rules.md#每家店的进展)。
- 两项等待都受任务报价截止限制，暂停也不重置计时，完整边界见 [inquiry-rules.md「等待回复」](inquiry-rules.md#5-等待回复sop-第六章-q2)；故障或截止未完成的记录见 [run-protocol.md「run.json」](run-protocol.md#runjson)。

### pollIntervalSeconds：查看回复的间隔（秒）

- `min`：最短间隔；`max`：最长间隔。
- 回复查看如何在两端间调整，见 [inquiry-rules.md「发询价与跟进」](inquiry-rules.md#发询价与跟进)。
- 建议 `min` 不低于 10。查得太频繁会增加平台风控的风险，也更费 AI 用量。

### maxFollowUpsPerShop：每家店最多追问几次

- 限制每家店的追问次数，建议 0 到 2；设为 0 只禁止追问，符合规则的答复、道谢和发错更正仍可发送。
- 哪些消息计入次数及如何处理缺项，见 [inquiry-rules.md「发给店家的消息」](inquiry-rules.md#4-发给店家的消息sop-第四章手册第-3-节)和[「把回复整理成报价」](inquiry-rules.md#6-把回复整理成报价)。

### dedupeDays：多少天内不向同一家店重复询价同一型号

- 查询本机同平台、同店名、同标准化型号历史的天数，可跨任务沿用；平台间同名店不合并，型号比较忽略大小写和连字符等符号；有价沿用、无价跳过的处理见 [run-protocol.md「本地防重复」](run-protocol.md#本地防重复)。
- 设为 0 表示不按历史记录防重复；同一任务内同店同型号去重、不同型号同店合并仍按[挑店规则](inquiry-rules.md#找店与挑店)处理。
- 记录只在本机，换电脑或别的用户问过，不会被识别。

### priceOutlierPercent：价格异常的判断标准（百分比）

- 同型号不含税单价低于各家中位价的异常提醒阈值，单位为百分比；只提醒，不删除报价。比较口径与标注见 [inquiry-rules.md「需要提醒用户的情况」](inquiry-rules.md#7-需要提醒用户的情况sop-第三四章)。

### thankYouMessages：信息齐全后的道谢说法

- 信息齐全后选用的道谢话术，至少保留 3 句简短、礼貌且不带业务信息（价格、型号、公司名）的结束语，不加「麻烦您了」「辛苦了」这类多余客套。
- 发送条件与话术约束见 [inquiry-rules.md「道谢」](inquiry-rules.md#45-道谢)，店家已结束聊天等停止条件见[「每家店的进展」](inquiry-rules.md#每家店的进展)。

### subagents：是否用子代理并行询价

| 键 | 含义 |
|---|---|
| `enabled` | `true`：本次启用两个及以上平台、且所用的 AI 支持子代理时，每个平台派一个子代理同时询价；否则用单代理交替推进。`false`：一律用单代理交替推进 |
| `stallMinutes` | 用子代理时，某个平台超过这么多分钟没打卡，主代理就按卡住处理（停掉它，保存 interrupted 断点，其他平台继续，本轮只留草稿、不取下一 IQ；不伪造业务结束，见 [execution.md「子代理卡住时」](execution.md#子代理卡住时)） |
| `claude.model` | 在 Claude Code 里运行时，平台子代理用的模型；实际可用性以当前工具为准，留空时不传覆盖值 |
| `claude.effort` | 在 Claude Code 里运行时，平台子代理的思考深度；留空时不传覆盖值 |
| `codex.model` | 在 Codex 里运行时，平台子代理用的模型 ID；以当前会话可用模型为准。留空时不传模型覆盖，沿用当前 Codex 的子代理默认值 |
| `codex.effort` | 在 Codex 里运行时，平台子代理的思考深度；所选模型支持范围以当前工具为准，留空时不传覆盖值 |

- `stallMinutes` 设得太短可能误判慢但正常的执行，太长则增加卡住后的等待。可参考实跑报告的最长打卡间隔 `maxGapMinutes` 调整；暂停与监控见 [execution.md「暂停与恢复」](execution.md#暂停与恢复)及[「打卡与监控」](execution.md#打卡与监控)。
- 这些设置只配置平台子代理，主代理沿用当前会话的模型与深度。较高思考深度可能增加耗时和用量，实际询价效果仍需实跑验证。
- 合法配置不代表当前客户端支持。模型/深度的派发参数、空值继承与不可用时的处理，只读对应的 [execution.md「Claude Code 派发与续跑」](execution.md#claude-code-派发与续跑)或[「Codex 派发与续跑」](execution.md#codex-派发与续跑)，不静默换模型；切换模型而留空深度时也要核对继承值是否受支持。
