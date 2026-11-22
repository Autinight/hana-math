# Hana Math

Hana Math 将 Danus 的数学研究流程接到 Hana：main 分派任务，worker 证明，独立 verifier 审阅，通过的事实进入共享事实图。原 Python Core、英文角色合同和 13 项 Skills 保留。与 Danus 的差异登记在开发仓库 `docs/danus-parity.md`。

## 开始研究

在 Math 设置中保存 main、worker、verifier、explorer 的模型。通过 `math_project create` 提供原题；新项目省略 `workerPolicy` 或传入 `{}` 均使用 Danus 默认研究轮次；既有旧项目保留原配置。`workers` 可设为 1–4，创建后固定。

`math_goal start` 在操作者授权后启动持续研究。main 使用 `math_assign` 分派任务并启动 worker，按 30 分钟控制节拍和四小时策略审计推进。多 worker 项目分派和启动须指定 `workerId`。研究模式的停止默认等当前数学轮结束，`force: true` 请求立即停止。Goal 状态里的 `workerStop` 是 stop 当时的回执，之后不更新；`workerStopReconciliation` 给出这次 stop 涉及的 run 现在是否结清（`settled` / `pending` / `unknown`），只是诊断，不重发 stop、不触发修复。

## 在聊天中保存研究共享偏好

本机的 Math App 只保存一份研究共享偏好，对应 Danus 部署里的 `OPERATOR.md`。在普通聊天里，可以先请助手用 `math_project operator_read` 查看已保存的回答，再自然询问还缺哪些项：称呼、回复语言、时区、通知偏好、美元告警值和默认 worker 名册。只有你本人明确选择共享的答案才保存；不确定就留空，助手不从聊天内容推断。示例：`{"action":"operator_save","answers":{"language":"中文","spendWarningUsd":12}}`。只更新提供的字段；传 `null` 清除某项。美元数值只是文字告警，名册只是偏好，二者都不修改预算、模型、worker 数或研究策略。

保存后，本机这个 App 的所有普通聊天都能读到这些回答，后来新建的项目的 Main / Worker 也会读到。因此不要填密码、密钥、私密联系方式、聊天记录或其他敏感资料。Math 自己的 Main / Worker / Verifier 等研究角色不能读写这份偏好，它们只读取项目里的 `OPERATOR.md`。读写偏好不会创建项目，也不启动模型、worker 或 Goal。

新建项目时如果省略 `operatorProfile`，会把当时已保存的回答复制一份进项目的 `OPERATOR.md`，之后再改偏好不影响这份副本；显式传入的 `operatorProfile` 优先；没有保存任何回答时沿用旧默认。已有项目不回填。旧版本按单个聊天保存的偏好不会自动迁移，需要时请重新保存一次。原题仍单独保存在 `PROBLEM.md`。

## 诊断与复查

`math_project doctor` 仅绑定的 main 可调，只读。它报告项目、run、Goal、Core 与恢复告警的未结项；读不到的项返回 `unknown`，不修复，也不证明可以续起。

`math_project recheck` 仅项目创建者可调，必须给出 `projectId`、`workerId`、`runId`。它复查一个已结束、带恢复标记的 worker run 的清理，可能移除定时、中止会话、把任务标为失败，不是只读操作；不重新开始研究。`mutationAttempts` 是尝试次数，不是成功次数。`RECHECK_NOT_NEEDED` 表示当前没有待复查的标记，本次未对账。

## 探索与证明

main 可用 Hana 原生 `subagent` 派发文字探索，以 `threadId` 续接、补充指令和关闭。每次新派发都显式指定 App 私有的 explorer 角色、其模型和 `access: "read"`，不使用全局默认助手。explorer 的模型在 Math 设置中保存；它关闭记忆，没有 App 业务工具。explorer 不可用时只停用探索，worker 与 verifier 照常工作。探索只产生建议，不产生事实。

探索意见须转成 worker 任务，经 verifier 接受后才能用作事实或证明前驱。原生结果到达可开启新回合或并入当前回合；main 开始处理有效新工作时使用 `continue_work`，无即时工作时再等待。子代理的工具集合由 Host 单独决定，不精确继承 main 的名单；原生模型选择也不直接复制父会话模型快照。

## 按次调配 worker 的模型与强度

worker 的模型与思考强度按 run 决定，由 main 在派工时指定，不需要预先配档位。

- `math_project worker_models` 按需查可用模型与各自支持的思考强度集，带 `projectId`，默认返回 32 条，上限 64。同响应给出保存的 worker 默认模型与思考强度控制的授权状态。不返回模型目录以外的 provider 配置。
- `math_assign` 的 `model` 与 `thinkingLevel` 是该次任务的待发配置。重新 assign 整体替换，省略即清掉上次偏好。
- `math_project start` 的显式字段逐项覆盖该 assignment 的对应项，未显式项继承。完全不带 dispatch 时保留旧行为：在 pipeline setup 时取一次保存的 worker 模型，后续轮次沿用该 run 快照。
- 本轮覆盖不写回 worker 角色预设，下一个项目仍是用户原来的配置。

思考强度需要单独授权。未授予时带 `thinkingLevel` 的启动明确拒绝，不静默忽略该字段，也不只设模型却显示已设强度。

## 阅读结果

- `fact_search` 按相关性查找已验证事实；`math_project result` 加 `factId` 读取完整证明。
- `result` 不带 `factId` 返回一页事实摘要；用 `nextCursor` 续读，遇到事实图变化须从第一页开始。
- `math_project finalize` 由项目创建者选择论文目标。不带 `factIds` 时仅建议终端事实，不写目标。

## 实时研究看板

**Σ 主页面（候选行为，待真机验收）。** 在 HanaAgent 主窗口的页面切换栏打开与 Code 同级的 Σ「研究看板」，即可跟踪允许展示的活动项目。无需创建或导入文件、请助手绑定或每 15 分钟续连。关闭页面只停止刷新；重开时按当时的研究状态重新选择。打开看板不会创建、启动或恢复研究。

多个可展示项目同时推进时，看板跟踪最近一次正式启动或恢复的项目；活动 Goal 等待 worker 时仍算进行中。当前项目暂停、停止或完成后，三个页签一起转到其余符合条件的项目。Σ 页可见时，当前页签通常在上一次读取结束约 8 秒后再刷新；页面隐藏时暂停刷新。**Overview** 显示事实数、验证结论和频道计数；**Fact Graph** 可点开证明并沿前驱查看依赖；**Global Memory** 显示 11 个共享频道，最新记录在前。

只有确认没有项目在推进时，才显示「当前没有正在推进的研究」。无法确认研究状态、展示权限或读取结果时，显示不可用提示，清空上个项目的数据，不扫描历史项目补位。自动跟踪只读现有看板数据，不读取私忆。入口只接受由 Host 确认属于本 App、连接分类为 `local` 且不带 document 或 agent 身份的界面会话；`local` 是 Host 对连接的分类，不能证明请求来自哪台物理设备，也不限定为 Σ 页面实例。仅凭 owner 或 studio-owner 登录不能读取。不改网络设置，不开外窗或局域网服务。

**旧文档入口保持原用法。** 在工作区打开 `.hanamathboard` 进入文档 Preview 后，可在项目的创建聊天里说“把这个项目连到当前看板”或“断开当前看板”。这只绑定当前文档视图，最多 15 分钟，重开后需重新连接。`math_project dashboard_snapshot` 导出的 `.hanamathgraph` 保存某一刻的事实图，只读、不刷新。只想在聊天里看数字时，`math_project dashboard_overview` 返回一次总览，不返回记录或证明正文。

## 事实图快照

`math_project graph` 加 `projectId` 导出离线交互 HTML，显示已验证事实的索引、结论预览与前驱关系。可筛选、选择节点、沿关系导航、缩放和平移。附件标明捕获时间和快照标识；完整证明仍用 `result` 加 `factId` 获取。

导出通过相同项目授权读取一致快照。事实图变化时最多重读一次；反复变化或超过 2048 条事实、32768 条关系、128 页或 2 MiB HTML 时拒绝导出，不返回残缺图。该快照不自动更新，也不包含全局记忆和完整证明正文。2048 节点上限低于 Danus 已记录的 3157 节点研究规模；更大项目的目标闭包视图和大图模式仍待实现。

## 进展报告

`math_project summary` 从原题和已验证事实生成 Markdown 报告，立即返回后台任务编号。用 `summary_status` 查询、`summary_result` 获取附件、`summary_stop` 停止。

独立报告助手使用已保存 verifier 的模型，关闭记忆和工具，不改三个研究角色。事实捕获时间和写作期间事实是否变化在状态与结果的元数据里给出，正文即写手原文；写作期间新增的事实不包含在内。发布前发现采用的事实被撤销或内容变化时拒绝发布，生成正文仍保留。成功、泄漏及失败工件保留历史；附件重取不重新调用模型。

### 阅读与打印

Markdown 报告始终保留。报告干净完成时（存档为 clean、泄漏检查无发现、字节校验完整），`summary_result` 还会附上一份离线 HTML：公式在生成时已用 KaTeX 排好，样式和字体都内嵌在文件里，不含脚本，打开时不需要联网。正文里的引用网址保留为可点击链接，点击前不会加载。如果报告需要外部或相对路径的资源（例如远端图片），就不生成 HTML，只交付 Markdown，结果里会说明原因；不会去抓取资源，也不改动正文。泄漏、失败或被标记的报告不生成 HTML。

需要 PDF 时，在创建项目的聊天里请助手打印。助手用已暂存 HTML 的 fileId 取到源文件，再调用 Host 的 `office_html-to-pdf`，关闭 JavaScript，由桌面 Chromium 打印引擎生成 PDF。这一步是网页打印，不是 TeX 编译，与论文源稿无关。助手不要把报告里的原始公式（`$...$`、`\boxed{}` 等）直接粘贴进聊天，那样只会显示成难以阅读的 TeX 源码。

## 数学论文源稿

`math_project paper_subgraph` 由项目创建者调用，读取已定稿目标的完整闭包，返回紧凑骨架：每条事实的单行 statement、前驱、闭包内后继计数和 glossary 键，不含证明或引用文本。它不接受选择集，不写论文，不改变目标；读取会记 Core 审计账。

项目创建者可先用 `math_project finalize` 保存每份论文的目标事实，再调用 `math_project paper`，提交项目问题摘要和写作要求。可选 `factIds` 显式选择进入全文的事实，最多 64 条。省略或空数组只在目标闭包小于 10 条时沿用完整闭包；闭包达到 10 条后必须非空选择，且不能覆盖完整闭包。显式选择必须包含全部目标事实；闭包外的同项目事实可使用，并带回读 warning。目标未设置时工具返回 `needs_target`，不会猜测目标。当前调用中的 `brief` 只写入该次不可变任务记录；如需更新应创建新任务，不覆盖既有源稿。

任务排队后用 `paper_status` 查看状态、`paper_result` 取得 `.tex` 和引用账本附件、`paper_stop` 请求停止。小闭包旧模式从目标的完整前驱闭包组装材料；显式模式只对所选事实供全文，引用账本取目标与选择的验证并集。状态与结果中的 `selection` 给出模式、选择、材料计数和 warning。论文 Agent 独立、无工具和记忆；模型取现有已保存 verifier 模型，但不会修改研究角色。读取采用项目的正式 Core FIFO 和创建者任务授权。

论文原始回答、LaTeX 源稿、provenance 映射与种子引用账本保存在不可变任务历史中。provenance 供后续核查使用，不作为普通附件交付。源稿中的 `\\note{.../blocker}`、`[GAP: ...]` 会保留并标为 flagged；含内部标识的 LaTeX 会隔离为诊断工件，不作为 `main.tex` 交付。变更或撤销目标、或改变已采用事实时，不完成源稿发布。重试附件不会重新生成文本。

源稿生成不等于发表准备完成。当前状态明确为：编译 not-run、引用 unverified、数学 unreviewed。目标闭包最多 2048 个事实、1 MiB canonical material，prompt 512 KiB，单个输出工件 2 MiB；超限拒绝，不截断。全篇证明审核、正式 LaTeX 编译、分块写作（section writer 与 stitch）、PDF 或外发发布仍未实现。没有完整 LaTeX 编译器时绝不把 HTML 转 PDF 称作论文编译。

## 线性章节计划预览

`math_project paper_plan` 由项目创建者调用，参数为 `projectId` 与 `brief`，可选 `paperId`（默认 `main`）、`instructions` 与 `factIds`。目标未设置时返回 `needs_target`。brief 必须非空，brief 与 instructions 各不超过 32 KiB。

省略 `factIds` 或传空数组时，计划覆盖目标的完整闭包；闭包达到 10 条以上或含多个 headline 时同样可用。显式 `factIds` 最多 64 条，必须包含全部目标事实，可以覆盖整个闭包；闭包外的同项目事实可以入选，并带 warning。全篇计划的覆盖与 `paper` 单次写作的「大闭包不得全选」规则相互独立，以后每次单独写作仍受那条规则约束。

planner 做一次 statement-only 模型调用：只看到覆盖事实的 statement 与前驱编号，不看 proof 或 intuition；引用账本取目标与选择的验证并集。它使用独立的 planner 身份和已保存 verifier 的模型，关闭记忆和工具。输出按上游协议分成四块：TeX preamble、frontmatter、线性 sections JSON 与 bibliography。这四块是未验证的规划材料，不是论文源稿。

用 `paper_plan_status` 查看状态、`paper_plan_result` 取附件、`paper_plan_stop` 请求停止，都加 `reportId`。默认附件为 `PLANNER_BLOCKS.json`（原四块）、`SECTION_PLAN.json`（原 sections、修复后的 sections、coverage 与 repairLog）和 `REFERENCE_LEDGER.md`。模型原文保存在任务历史中，不默认交付。修复沿用上游：重复事实保留首次，覆盖外的编号丢弃，漏项补入 Additional results。

只有干净完成且任务已结算的计划显示 `reviewable-plan` 和 exact-once coverage，其他状态为 `not-ready`。章节顺序未检查（`sectionOrdering: not-checked`），引用 not-requested，数学 unreviewed，编译 not-run。失败结果分别说明原文、四块、计划与账本是否已保存。附件重取与恢复不重新调用模型，损坏的归档不交付。

此功能不生成 `main.tex`，不做 section-fill、stitch、编译或 PDF；线性 planner 也不等于人工 chapter tree。prompt 上限 512 KiB；模型回答超过 512 KiB 时由共享会话层拒绝，不截断。128 个 sections、title 与 label 各 4096 UTF-8 字节，以及解析器与原文工件的 2 MiB 上限，都是 App 自设的护栏；2 MiB 不是可用的回答额度。

## 单节论文写作

`math_project paper_section` 由项目创建者调用，参数为 `projectId`、`planReportId`，可选 `previousSectionReportId`。不带 previous 时写父计划的第一节；带 previous 时，它必须属于同一计划和快照，已完成、已结算且归档有效，本次写它的下一节。用 `paper_section_status`、`paper_section_result`、`paper_section_stop` 加 `projectId` 和 `reportId` 查询、取回或停止。

每次调用只写一节，不自动推进或重试。失败后应基于上个成功片段重新调用；从同一前驱可以显式建立不同重试分支。首节重试产生新的 chainRoot，后续重试继承原 root。previous 已是末节时返回 `no_next_section`，不创建报告、任务或模型调用，也不表示整篇已经组装或认证。带 blocker 的 flagged 成功片段可以作为前驱，失败片段不能。

本节分配的事实是局部目标：全文只供应这些事实，直接前驱只提供 statement，不自动扩入祖先。局部祖先闭包达到 10 条且本节事实覆盖整个闭包时，启动 writer 前返回 `PROJECT_PAPER_SECTION_REPLAN_REQUIRED`；全局 headline 规则不逐节复用。本节事实最多 64 条。空 `fact_ids` 的编辑性章节仍真实调用 writer，事实全文与前驱 statement 块为空；brief、fixed frontmatter 等共享材料仍可能含已有数学概述，不作语义认证。

父计划的 capture 与归档哈希保持不变，新鲜读取只用于核对，不能覆盖原快照。默认附件只有 `section.tex`、`SECTION_RESULT.json` 和 `REFERENCE_LEDGER.md`；模型原文与 provenance 留作内部诊断。正文 trim 后为空会拒绝交付，leak 为硬失败，blocker 只令片段 flagged。只有干净完成且已结算的片段显示 `reviewable-section`。

本片不输入前节正文，不改写父计划或前节的内容与输入绑定；损坏隔离和恢复诊断是独立记账。不生成 `main.tex`，不做 stitch、编译、全篇数学复核、PDF 或自动 chapter tree。历史片段只证明自己的冻结归档，整链检查留给后续 stitch。

## 离线引用审计

项目创建者可用 `math_project paper_audit`，传入已完成源稿的 `projectId` 和 `reportId`。任务返回新的审计 `reportId`；后续用 `paper_audit_status`、`paper_audit_result`、`paper_audit_stop` 加这个新编号查询、取回或停止。blocker 源稿可以审计；隔离、失败或损坏的源稿会被拒绝。

审计只读取该源稿及其引用账本，固定输入字节、原始审计合同和 prompt 的哈希。独立审计助手关闭记忆和工具，使用已保存 verifier 模型。输出 `REFERENCE_AUDIT.md` 是离线建议，引用状态保持 unverified；不会修改源稿或账本，也不会自动触发在线核验或修订。附件重取不重新生成审计。当前上限为 prompt 512 KiB、单工件 2 MiB，超限拒绝。

## 在线引用核验

`math_project paper_verify`：创建者传入已完成离线审计的 `projectId` 和审计 `reportId`，取得新的核验任务编号。后续用 `paper_verify_status`、`paper_verify_result`、`paper_verify_stop` 操作这个新任务。

独立核验员读取绑定的源稿、账本和审计意见，核对所有仍未确认的账本条目。它使用保存的 verifier 模型、关闭记忆，只选择原生 `web_search` 和 `web_fetch`；不选择 Matlas、local read 或写工具。网页发现与来源读取受 Hana 的独立权限和服务可用性约束。结果为 `REFERENCE_VERDICTS.json` 和新版本的 `REFERENCE_LEDGER.md`，旧源稿、旧账本与审计正文保持不变。纠正引用的建议留给后续修订，不自动改写 `main.tex`。

核验结果逐条标为 verified、corrected、rejected、unverifiable 或 retarget-internal。verified/corrected 必须有来源 URL 和完整确认元数据；缺来源的条目保留未确认状态。全局引用状态为 verified、partial 或 unverified，表示核验员的来源判断；它不表示全篇数学审查或编译已经通过。网页不可达或工具拒绝时应保留失败或未确认结论。附件重取和恢复不重新调用模型。

首次真机核验在模型发送前的工具选择阶段失败。正式 API 回读确认专用 verifier 保存为显式 `light` 模式；失败 session 的工具快照没有 Matlas。该快照只列当时记录的工具名，不证明当前可用性。0.17.3 将核验会话的精确选择限定为原生 `web_search` 与 `web_fetch`，不查询或调用 Matlas，也不读取或改写 verifier 配置；保存的模型和模式保持不变。新 verifier 使用独立 registry，旧 Matlas 合同记录原样保留。0.17.3 的新真机任务已确认该双工具选择，模型请求完成并返回五条核验建议；保存模式仍是 `light`。这是 verifier 的来源判断，不表示全篇数学已复核。旧失败任务没有重放，也未增加 `read` 工具。

## 论文修订提案

创建者可对已完成、已结算的在线核验报告调用 `paper_revise`，得到新的 revision child 报告。也可使用 `mode: operator-notes` 和 `notes`，直接修订已完成、已结算的 paper-source；notes 原字节留档，状态和结果只显示哈希与字节数，不回显正文。此模式的 citationStatus 为 not-requested，不伪造核验判断。用 `paper_revision_status`、`paper_revision_result`、`paper_revision_stop` 管理提案。citation 提案绑定原源稿、verdict、派生账本和 provenance 的字节哈希；operator-notes 绑定原源稿、原账本、原 provenance 与 notes 的哈希，不含 verdict。新 TeX、修订摘要和继承账本只写入子报告。provenance 作为子报告内部材料保留，不在默认附件列表中。父稿或核验报告不会被覆盖。恢复不重放模型，附件重取只重新交付既有工件。

完整解析的 empty、no-change、not found、ambiguous 或 overlap patch 会逐项跳过，其他有效项继续应用；外层结构损坏仍拒绝。没有实际变更时返回 `no_edits_applied` 和逐项诊断，不生成新 proposal，`paper_revision_result` 的 `files` 为空。failed 或 running 记录不会被当作成功 no-op。

该结果是待复核提案，不会自动发布为 canonical paper。citation status 表示父核验来源的判断，不代表改后文本已复核；父 provenance 作为内部历史材料继承且未重新验证。即使修订器移除了 blocker，若原源稿为 flagged，提案仍保持 flagged。后续提案会把父 provenance 仅作为历史归档，并将全部父标签列为未解决；改后 TeX 的保守词法扫描只检查可见引用键是否出现在账本，不展开宏或判定来源。未知或无法扫描的引用形式会标记提案，不会自动发布。

## 报告读取的错误标记

下列 7 组读取按同一规则标记 `isError`：summary、paper、paper_audit、paper_verify、paper_revision、paper_plan、paper_section 的 `_status` 与 `_result`。各 `_stop`、授权与输入校验不在此列，行为不变。

`isError:false` 只表示这次读取成功，不表示报告成功。读一份历史上 failed、stopped 或 interrupted 的报告时返回 `isError:false`，DTO 保留原 state、error、status、diagnosis 与 files，调用方必须检查这些字段。例如某节因 `RESEARCH_RUNTIME_CAPACITY` 失败后，`paper_section_status` 仍以 `isError:false` 返回 `state: failed` 与该错误码。

本次调用没有完成时才标红。例如 `paper_section_result` 本次导出部分失败，返回 `isError:true` 与 `readError: { code: 'PROJECT_REPORT_EXPORT_FAILED', phase: 'delivery' }`，报告原 error 与逐文件回执保留，已导出的附件不抹除，但不算整套交付成功。之后再查 `paper_section_status`，看到的上次 delivery 失败属于历史，返回 `isError:false`。

`readError` 只出现在触发它的那次响应中，不保存。另一种是 dirty section 在本次读取中首次发现归档损坏：返回 `isError:true` 与 `readError: { code: 'PROJECT_REPORT_ARTIFACT_INVALID', phase: 'archive-validation' }`。`archiveError` 则长期保存在报告记录中：之后的读取，或加载时已降级的报告，返回 `archiveError` 与 not-ready，`isError` 为 false，但仍表示归档已损坏。clean 报告归档损坏、输入错误、授权失败与 NOT_READY 都标红。summary 失败报告的 result 仍返回 NOT_READY；leak、no-op 与成功 flagged 的现有表现不变。

App 输出的文本包含错误码。Host 的 CodeMode 是否在抛出的 message 中展示该码、部署后现场表现如何，尚未验证；此前现场在 CodeMode 中观察到的是抛错。

## 容量拒绝类别（软件已验，未部署）

本节合同已在 main 实现并通过软件验证，尚未部署；已安装的 0.25.0 不含此合同。`paper_plan` 与 `paper_section` 遇到 managed IPC 本地容量拒绝时，顶层错误码仍为 `RESEARCH_RUNTIME_CAPACITY`，判定与优先级不变。只有当本地检查的拒绝能绑定到本次调用的主错误时，才额外附一个简短类别；仅凭同一错误码不足以附类别。

- 当次发起被拒：工具返回红，主错误带 `error.managedIpcRefusal: { source: 'current', category: 'directory-limit' }`。
- 历史读取：plan 或 section 的 status/result 读到一份以容量码失败、且有合法记录的报告时，返回 `isError:false` 与 `state: failed`，顶层附 `managedIpcRefusal: { source: 'recorded', category }`。这仍是一次成功读取；recorded 表示拒绝当时记录的类别，不是新的证明。

类别只有五种：`entry-limit`、`unsafe-entry`、`invalid-completion-marker`、`directory-limit`、`byte-limit`。`byte-limit` 计入保守预留，不表示物理磁盘已满。新增的 `managedIpcRefusal` 只含 `source` 与 `category`，不披露 IPC 计数、余量、路径或其他项目的信息。旧报告没有类别或字段畸形时直接省略；缺少类别不能用来推断拒绝原因。

## 当前限制

事实图检查与报告文件发布不构成跨进程原子事务；报告反映标注时点的事实快照。实时研究仪表板尚未实现。

真实研究已验证主干流程、双 worker、跨 worker 引用、自然 30 分钟节拍、分页和 finalize；尚无真实 wrong→repair、自然四小时审计或两条结果同时送达 main 的证据。未关闭事项见开发仓库 `docs/open-issues.md`。

真实研究次数不作为验收标准；当前已验证能力与未关闭事项见开发仓库 `docs/open-issues.md`。数学只用文字和符号推理。共享记忆用于交流，只有验证通过并入图的事实可用作证明前驱。模型凭据由 Hana 管理；App 通过正式权限入口使用模型、任务和文件，不自动发布论文或推送 Git。
