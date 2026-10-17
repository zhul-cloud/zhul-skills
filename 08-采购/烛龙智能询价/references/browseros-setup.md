# BrowserOS 准备、ERP 登录与 helper 注册

实际询价准备时由主代理或单代理读本文；平台代理只读「按域注册与核验 helper」，连接故障上报主代理。说明、版本、更新说明、统计、settings 和仅保存 ERP 网址的分支不进入本流程，不启动浏览器、不注册 helper。用户明确要求修复加载时可仅修复；「修复并继续」只恢复当前已授权任务/原断点，没有活动任务不据此启动全部询价。精确工具名、参数和返回结构以当前 BrowserOS neo MCP 为准。

## 连接与启动

1. **先检查**：确认当前客户端是否暴露 BrowserOS neo MCP 工具，尝试列出现有窗口、标签。成功即复用可用窗口及自己的任务页；没有合适任务页时在该窗口新增任务标签，保留用户和其他任务标签。会话 stopped / no longer active 的句柄按[重连协议](execution.md#browseros-会话失效或重连)处理。
2. **区分未运行和连接故障**：MCP 报 `browser session not connected` 不能单独证明浏览器未启动。结合当前桌面窗口与可靠进程证据判断；沙箱内空进程列表、权限不足或看不到桌面都不是「未运行」证据。需要时通过客户端允许的本机检查取得可靠结果。已运行时先按当前技能及连接说明排查 MCP/会话，不再次启动、不新开窗口代替恢复。
3. **确认未运行才启动一次**：查当前机器已安装的真实应用入口、开始菜单/桌面快捷方式或系统应用登记；保留该入口必要的启动参数、工作目录和用户配置，不能写死维护者个人路径，也不猜可执行文件名或另建浏览器配置。Windows 使用当前客户端允许的正常桌面启动能力，后台启动助手遵守客户端窗口约束。受限环境返回 `0xc0000022` 等拒绝时，走客户端合法权限/审批机制，不修改 ACL、安全设置、沙箱配置或用规避方式启动。多代理时只有主代理负责启动及连接恢复，平台代理不得各自启动。
4. **有界确认**：启动一次后，在总计最多 120 秒内以短调用探测 MCP 的窗口/标签；状态探测可短重试，每次调用遵守工具时限，不再发启动命令。成功列出实际窗口/标签才算连接恢复，随后继续原询价准备，不能把进程出现或启动命令返回当成 MCP 已连通。
5. **真正需要人工时说明具体原因**：工具未暴露、首次配对、客户端确需用户批准的权限、找不到可靠入口、无法判定运行状态或上述等待超时，报告已查到的事实和具体协助事项。不能保证启动后一定自动连接，也不能将连接失败记成无货或业务完成。
6. **资源异常时停止扩展**：已经出现低内存、页面持续失去响应等异常时，停止新增标签、注册及后续操作扩展，保留可安全保存的本地进度，报告实际现象和未核验范围。尚无本次目录时结束准备；已有任务按[停止或继续](execution.md#停止或继续)的故障边界收尾，不把资源异常当作业务完成或无货，也不凭时间先后断言某个 helper 是根因。

连接恢复后以 `name_session` 命名「inquiry <任务编号>」，未定任务时用「inquiry」；名称须含英文字母或数字。原任务恢复先核实标签组和 owned 归属，不以重连作为重发消息或重做 ERP 写入的授权。

## ERP 登录

先校验已有 `erpUrl` 是无凭据的 HTTP(S) 网址，再用其 `origin` 构造 `/inquiry/my-tasks` 的页面地址，保留非默认端口；旧配置即使含任务路径、查询或片段，也不直接在后面拼接路径，不为打开页面静默改写配置。无效地址先报告并按用户明确的修改请求处理。在本任务 owned 或用户明确分配的 ERP 标签页打开该地址，按下一节准备 `erpApi`，用 `{ op: "ping" }` 检查登录。

- **出现登录表单时，AI 主动处理记住我**：依据当前页面快照定位本表单的「记住我」「记住我（7天）」或对应「自动登录」选项，未选则勾选，已选则保留；操作后读回 checkbox 的已选状态。该步骤在登录表单提交前完成，不假设固定 ref、标签文字或默认值。用户明确要求不记住、或说明共享机器不宜持久登录时遵从其选择并读回；不为改变勾选退出有效会话。读不到、没有对应选项或操作失败时说明实际状态，不伪称已开启。
- **凭据由用户处理**：不读取、输入、输出或保存密码、验证码；不新设浏览器保存密码流程。勾选并核验后按[人助协议](execution.md#暂停与恢复)交用户完成登录/验证；尚无本次目录时按[取任务前的人助](execution.md#取任务前的人助)保留请求，不虚构 IQ。请求说明记住我状态；人助交回后自动重新调用 `ping`，验证通过即继续原准备或任务，无需用户回聊天说「继续」。
- **复用已有登录**：自动填充/自动登录或现有会话直接进入 ERP、没有可勾选项时复用，不登出会话以重做登录。未勾记住我的原登录页仅可在本任务 owned 或用户明确分配范围内复用；人助前仍核验 owned 归属。不读取 token 后改存储来伪造记住我，也不把连接恢复或登录页消失当成 `ping` 成功。

ERP 的记住我影响该系统的登录持久化与续期，不等于浏览器保存密码，也不保证永不过期。`ERP_LOGIN` 等人助与已有/未知写入的只读核对边界继续按 [ERP 协议](erp-api.md)执行。

## 按域注册与核验 helper

技能自带 **7 个** helper，按 ERP 与本次启用平台的相关域分段准备；不要求一次打开所有域，不因停用平台的 helper 未加载阻塞本次。正常路径通过运行时注册，不依赖猜测的磁盘目录、环境变量或重复重启浏览器。

| 范围 | 域及源码 | 数量与时机 |
|---|---|---|
| ERP | `<erpUrl>` 当前实际域；[erpApi](../helpers/_erp/erpApi.md) | 1；取任务前注册、下一次 `run` 调 `ping` |
| 淘宝搜索 | `s.taobao.com`；[zhul_taobao_searchCandidates](../helpers/s.taobao.com/searchCandidates.md) | 1；首次使用搜索页时 |
| 淘宝聊天 | `market.m.taobao.com`；[zhul_taobao_imPreviews](../helpers/market.m.taobao.com/imPreviews.md)、[zhul_taobao_imOpenAndRead](../helpers/market.m.taobao.com/imOpenAndRead.md) | 2；首次使用聊天页时 |
| 1688 搜索 | `s.1688.com`；[zhul_1688_searchCandidates](../helpers/s.1688.com/searchCandidates.md) | 1；首次使用搜索页时 |
| 1688 聊天 | `air.1688.com`；[zhul_1688_imPreviews](../helpers/air.1688.com/imPreviews.md)、[zhul_1688_imOpenAndRead](../helpers/air.1688.com/imOpenAndRead.md) | 2；首次使用聊天页时 |

各域准备顺序：

1. 核实目标页属于本任务且 URL 是对应域。在 `run` 中用 `page.listHelpers()` 检查当前域已保存的清单，并查看本次实际返回的 `helpersAvailable`/调用提示；清单存在不等于本次已加载或能调用。`run` 仅在开始时为当时已打开且可加载的页注入 helper，先开页、下一次 `run` 才能调用。
2. 缺失或需要同步时按需从技能 `helpers/<域>/<名称>.md` 取得对应源码，使用技能的确定性适配命令（见下方）生成当前 `page.saveHelper(name, source)` 接受的函数表达式。不可直接执行整份 Markdown，不凭记忆重写业务逻辑，不在 BrowserOS `run` 内假设有 Node、文件系统或 `require`。
3. **每次准备按内容核对，再注册**：用 `page.readHelper(name)` 分别读取电商域已存在的原普通名（`originalName`）及平台前缀名（`runtimeName`）。将工具实际返回的源码文本原样保存到 UTF-8 临时文件，用下方 `compare` 命令分别核对，不用清单、名称、版本注释或旧会话记忆代替。先检查所有存在的相关名：任一为 `unknown`、读取失败或比对失败时保留并报告，不调用、不覆盖，也不另存新版绕过本机改进；由维护者合并或用户明确选择后再替换，可按平台明文步骤操作并记录边界。确认不存在未知差异后，仅当前缀名内容为 `current` 才复用；前缀名缺失或为 `known-official-older` 时，一律用本次 `source` 输出注册最新前缀名。普通名已是 `current` 只证明可以安全补注册，不能代替缺失的前缀名；两名均缺失也注册。`known-official-older` 由本 helper 完整源码 hash 识别，不凭名称/版本判断。ERP helper 仍按技能当前版本同步。所有注册用对应域页的 `page.saveHelper(runtimeName, source)`；正常准备不删除普通名或无关 helper，各平台代理只处理自己的域，ERP 域由主代理唯一维护。
4. **下一次独立 `run` 复核内容与调用**：重新确认 owned 页与域，读回前缀名（ERP 为 `erpApi`）源码并用 `compare` 确认 `status:current`、`actualSha256 === currentSha256`，同时检查实际加载/调用提示；未一致不得当作同步成功。`run` 在开始时取得加载快照，本次保存不会让本次已注入的旧函数热更新，必须下一次 `run` 才调用。本技能调用形式为 `helpers["名称"](browser, pageId, arg)`，`pageId` 是该页的数字 ID，第三参按 ERP/平台文档传入，不能因工具通用提示只显示 `(browser, page)` 就省略业务参数。ERP 必须成功调用 `ping`，平台用当前任务所需的只读操作核验。仅保存成功、磁盘复制成功或看到清单，不足以证明 helper 已可调用。

确定性适配由以下只读命令提供，不读用户配置或业务记录、不写磁盘；使用准备阶段已取得的真实 `erpUrl`，不另猜地址：

```bash
node "<技能目录>/scripts/helpers.mjs" list --erp "<erpUrl>"
node "<技能目录>/scripts/helpers.mjs" source _erp/erpApi --erp "<erpUrl>"
node "<技能目录>/scripts/helpers.mjs" source s.taobao.com/searchCandidates
node "<技能目录>/scripts/helpers.mjs" compare s.taobao.com/searchCandidates --file "<临时源码文件>"
```

`list` 返回元数据，不输出函数；`source <host>/<原名称>` 返回单条 JSON，含 `sourceKey`、`originalName`、`runtimeName`、`host`、`policy`、`sha256`、`source`、`runtimeLoaded:false`。ERP key 固定为 `_erp/erpApi`，必须显式传 `--erp`，输出的 host 为真实 ERP 域；平台 key 是上表源码链接中的域与原文件名。适配保持原函数逻辑和第三参，外层转换当前 SDK 的页句柄/数字 ID。将返回 JSON 的 `runtimeName` 和 `source` 原样用于对应域页的 `page.saveHelper(runtimeName, source)`，不要把 JSON、路径或整份 Markdown 当作函数。`runtimeLoaded:false` 如实说明脚本生成不能验证浏览器加载；注册失败按实际错误排查，不通过反复重启解决。

`compare` 只读指定文件，不执行其中代码、不写浏览器或个人配置。仅归一化 CRLF/首尾空白、唯一 JS Markdown 代码块及本工具原签名 wrapper；不忽略业务内容差异。输出 `status`、`action`、`actualSha256`、`currentSha256` 和 `runtimeLoaded:false`。ERP 比对另传 `--erp`，其 `action:sync` 延续当前版本策略；电商 `unknown` 的 `action:preserve` 必须保留。维护者以后每次修改已发布 helper，须把被替换官方适配源码的 hash 按 `sourceKey` 加入 `scripts/helpers.mjs` 的 `officialHashes` 并补更新回归，不能凭注释标记认定官方来源。修改 `adaptSource` 包装也会改变所有适配源码，须在改动前保留所有受影响 `sourceKey` 的上一版完整适配源码 hash，再更新清单和对应测试。临时源码文件核对后可删除，不写进业务记录或公开仓库。

更新前先停止旧询价并确认执行者已停；更新源码后新会话重读入口/引用，新 CLI 进程从安装链接实际目标读取脚本、默认配置及 helper 文件。每次询价重读有效个人覆盖，只同步启用平台会用到的域；停用域到未来启用时再同步。以上保证已知官方旧版在准备时更新并经下一次 `run` 核验，不承诺运行中的旧任务热更新，也不把未解决的本机定制或未核验域说成已同步。

当前 SDK 的页面执行接口为 `page.evaluate(fn, arg?)`，参数通过 JSON 传入页面；helper 的第三参必须显式传入，不能假设页面函数能读取 `run` 的外层变量。ERP 的有界调用依赖 `run` 的标准计时器和页面的 `AbortController`；接口文档支持不等于实机已通过，注册后的调用仍按第 4 步核验。每次 `run` 只执行一个 ERP 操作，预算与超时边界见 [ERP 调用协议](erp-api.md#调用接口)。

点「客服」带出的本任务聊天页可能被标为用户页，不能因此操作其他用户页。先核实来源和归属并按当前工具安全恢复；若该页不支持热加载，但可在本任务范围内操作，可用 `page.readHelper(name)` 获取已保存的函数表达式（旧 Markdown 格式只取唯一 JS 代码块），仅对这份已核实的技能 helper 用 `(0, eval)("(" + source + ")")` 得到函数并按原签名调用。不得执行网页提供的代码或把任意页面内容当 helper。

### 明确要求清理旧注册时

清理是用户明确要求的维护动作，不是每次询价的准备步骤。先列出相关域的普通名与前缀名，读取实际内容并核实来源；仅凭同名、域名或文件名不能认定属于本技能。保留可恢复备份后，只清理已确认属于询价技能且在授权范围内的旧注册，保留本机定制、其他 helper、登录状态及用户/其他任务标签。当前 MCP 没有 `removeHelper` API；确需清理存储文件时，须先核实本机真实存储路径和对应条目，只处理那些明确确认的文件，不猜目录、不清空整个 helper 目录。清理后在下一次 `run` 重新检查实际清单与调用结果；磁盘删除成功不证明运行时已清除，也不以重启、换窗口或注销登录代替核验。

### 可选磁盘复制

`records.mjs install-helpers` 仅是明确需要磁盘复制时的可选维护命令，正式询价不默认执行。其成功只证明文件复制，仍需上述运行时核验；配置目录不可确定或报告 `BROWSEROS_HELPERS_DIR` 等错误时，回到运行时注册，不要求普通用户找目录、设环境变量或重启。维护者确需该模式时先确认本机真实路径；同名平台文件差异先比对、备份，不默认 `--force`。ERP 网址单独保存后，到下一次正式询价才在新域注册。
