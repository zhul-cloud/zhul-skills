# 08 · 采购

发给采购人员、在他们自己电脑上运行的 AI 技能，配合 zhul-trade-erp 的「我的询价」使用，但不属于 ERP 程序。由采购负责人管理和发放。2026-10-15 从 zhul-trade-erp 仓库的 `purchaser-skills/` 迁入本库。


| 技能 | 版本 | 用途 |
|---|---|---|
| [烛龙AI询价](烛龙AI询价/SKILL.md) | 1.1.0 | AI 自动询价：读取 ERP 询价任务 → 各平台同时找店询价 → 在任务页面填报价并提交回价（一次一个任务；一期只启用淘宝） |

## 采购电脑需要准备

1. **Claude Code 或 Codex**（任选其一，已登录）。两者都通过 npm 安装，装好后电脑上就有 Node.js，技能里的脚本不需要再装其他东西。
2. **BrowserOS neo**，并把它的 MCP 连接到 Claude Code 或 Codex（在 BrowserOS neo 的 MCP 连接页面一键连接）。
3. 在 BrowserOS neo 里登录：公司 ERP（AI 使用的采购账号）、淘宝买家账号。AI 只使用已有的登录状态，不输入密码。

## 发放与安装

把整个 `烛龙AI询价` 文件夹拷给采购，放到：

| 使用的 AI | Windows | macOS / Linux |
|---|---|---|
| Claude Code | `C:\Users\<用户名>\.claude\skills\烛龙AI询价\` | `~/.claude/skills/烛龙AI询价/` |
| Codex | `C:\Users\<用户名>\.codex\skills\烛龙AI询价\` | `~/.codex/skills/烛龙AI询价/` |

两个都用就各放一份。macOS 的访达默认隐藏以 `.` 开头的文件夹，按 `Cmd + Shift + .` 显示，或在访达「前往文件夹」（`Cmd + Shift + G`）里输入上面的路径。新开一个会话后，对 AI 说「帮我询价 IQxxxx」即可。AI 每次运行时会把技能自带的站点脚本（`helpers/`）装进 BrowserOS neo，已是最新的跳过。

**用 install.sh 安装**（维护者自己的电脑，或已克隆本仓库的采购电脑）：仓库根目录的 `install.sh` 会把本库**所有**技能（含烛龙AI询价）以软链接装进 `~/.claude/skills/`，`git pull` 后自动生效。它只装 Claude Code，不装 Codex；采购只需要询价技能时，按上表单独拷文件夹即可。Windows 上在 Git Bash 里运行时，没开「开发者模式」的话 `ln -s` 会变成复制，`git pull` 后要重新运行一次。

**升级**：用新版文件夹整个替换旧的。询价记录和本机经验存在数据目录（Windows `C:\Users\<用户名>\.zhul-trade-sourcing\`，macOS/Linux `~/.zhul-trade-sourcing/`），不在技能文件夹里，替换不会丢。`settings.json` 会恢复成新版默认值，改过的设置要重新改（见 `烛龙AI询价/references/settings.md`）。

## 修改规则

| 要改什么 | 改哪个文件 |
|---|---|
| 发询价前是否确认、询价店铺数、等待时间、轮询间隔、追问次数、防重复天数、价格异常标准 | `烛龙AI询价/settings.json`（详细说明见 `烛龙AI询价/references/settings.md`） |
| 流程、红线 | `烛龙AI询价/SKILL.md` |
| 挑店标准、话术、货况货期对照 | `烛龙AI询价/references/inquiry-rules.md` |
| 各平台页面操作 | `烛龙AI询价/platforms/<平台>.md`（目前只有 `taobao.md`；新增平台的说明文件经实跑验证后放进来，该平台即启用） |
| 站点脚本 | `烛龙AI询价/helpers/<域名>/<脚本名>.md`（BrowserOS neo 站点脚本格式） |

## 收集各采购电脑上的经验

技能运行后，会把新发现的页面事实写进采购电脑数据目录下的 `learnings/`，新做的站点脚本存在 BrowserOS neo 的站点脚本目录：

| 系统 | 站点脚本目录 |
|---|---|
| Windows（已实测） | `%LOCALAPPDATA%\BrowserClaw\User Data\.browseros\.browserclaw\helpers\` |
| macOS（推定，未实测） | `~/Library/Application Support/BrowserClaw/.browseros/.browserclaw/helpers/` |
| Linux（推定，未实测） | `~/.config/BrowserClaw/.browseros/.browserclaw/helpers/` |

macOS、Linux 的目录是按 Chromium 的惯例推定的。如果 `records.mjs install-helpers` 报找不到目录，就在该电脑上找到实际目录，用环境变量 `BROWSEROS_HELPERS_DIR` 指定，再把实际路径更新到本表和 `records.mjs`。维护者定期收集，把通用的合进技能（页面事实进 `platforms/`，脚本进 `helpers/`），升级版本后发放，再删掉经验文件里已合并的条目。

每次运行结束，技能还会在采购电脑数据目录下的 `reports/` 写一份实跑报告（`<YYYY-MM-DD>-<任务编号>.md`，含结果、各阶段耗时、问题、红线执行情况、建议），只存本机，用来分析效率和排查问题。报告里有店铺名和采购价，属于公司内部数据，收集时不要放进本仓库（本仓库公开）。

改完按下面的规则升级版本号，同时修改 `SKILL.md` 开头的 `version`、上表的版本号，并在「版本记录」里写明改了什么，再重新发放。技能每次运行时会先输出版本号，采购反馈问题时请附上这行，方便判断是哪一版。

| 改动 | 版本号 | 例 |
|---|---|---|
| 修正文字、补充说明，询价行为不变 | 修订号 +1 | 0.2.0 → 0.2.1 |
| 规则或流程变化（话术、挑店、税率、等待时间等） | 次版本号 +1 | 0.2.1 → 0.3.0 |
| 流程整体改写，旧版不再适用 | 主版本号 +1 | 0.x → 1.0.0 |

## 版本记录

- **1.1.0**（2026-10-15）：从 zhul-trade-erp 迁入 zhul-skills，技能改名为「烛龙AI询价」（原 `zhul-trade-sourcing`），运行时第一行改为输出 `烛龙AI询价 v<版本号>`；文档补充 macOS、Linux 的安装位置和数据目录，`records.mjs` 按系统选择 BrowserOS neo 站点脚本目录（macOS、Linux 未实测，可用环境变量 `BROWSEROS_HELPERS_DIR` 指定）；本机数据目录仍是 `C:\Users\<用户名>\.zhul-trade-sourcing\`，原有询价记录和经验继续可用。已装旧名文件夹的电脑，先删掉 `zhul-trade-sourcing` 文件夹再放新文件夹，避免同一个技能装两份。新增实跑报告：每次运行结束写到本机 `<数据目录>/reports/<YYYY-MM-DD>-<任务编号>.md`，`records.mjs init` 会创建 `reports/`。原放在仓库里的首次实跑报告已移到维护者电脑的数据目录，不再随仓库发布。
- **1.0.0**（2026-10-15）：按在线流程整体改写，Excel 版不再适用。AI 用采购提供的登录状态读取「我的询价」任务，在任务页面填报价并**直接提交回价**，不再下载和上传询价包（删除 `package.mjs`）。一次只跑一个任务，任务内各启用平台同时询价（`platforms/` 下有说明文件的平台才启用，目前只有淘宝，1688、闲鱼待实跑验证后加入）；新增 `confirmBeforeSend` 开关，默认自主执行；每个平台询价店铺数默认固定 3 家；新增 `settings.json` 详细说明 `references/settings.md`。合入 2026-10-15 实跑经验：发送前核对会话标题、发送后读回；发错对象时只发一句固定更正；只开一个聊天页；所有店盯到截止时间；读到回复后点开会话清红点；挑店参考回复和发货速度；价格异常按中位价判断；ERP 页面填写要点。技能自带 3 个只读站点脚本（`helpers/`），由 `records.mjs install-helpers` 安装；本机增加已处理任务记录，避免同一任务重复跑。
- **0.2.0**（2026-10-15）：新增临时规则，ERP 系统改造后删除：询价话术末尾补问「是否全新原装」；含普票按含税 3%、含专票按含税 13%、未说明票种按 13% 并备注。每次运行前先输出版本号和这两条临时规则。流程仍是 Excel 版，按「直接在 ERP 页面填报价」的新流程整体改写尚未进行。
- **0.1.0**（2026-10-14）：首版。一期只做淘宝；规则整理自《采购岗位 SOP》和《询盘单 Excel 操作手册（含店铺筛选标准）》。尚未实际运行，淘宝页面细节待首次运行时核对。
