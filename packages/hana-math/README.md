# Hana Math 使用说明

Hana Math 接入 Danus 的数学研究流程：main 派工，worker 写证明，独立 verifier 核验。只有通过核验并入图的事实可作证明前驱；探索建议和共享记忆只供参考。模型核验不等于形式化证明。

## 开始研究

1. 在 Math 设置保存 main、worker、verifier、explorer 四个角色的模型；如需编译论文 PDF，可在同一页的「LaTeX 编译」填本机 `pdflatex` / `pdftex` 路径（留空则自动探测常见 TeX Live / MacTeX 路径）并点「测试编译」确认。
2. 在普通聊天里请助手用 `math_project create` 建项目，提供原题。`workers` 可设为 1–4，创建后固定；省略 `workerPolicy` 或给 `{}` 使用 Danus 默认研究轮次，旧项目配置不改。
3. 确认后用 `math_goal start` 开始持续研究。main 用 `math_assign` 派工、启动 worker，按 30 分钟控制节拍和四小时策略审计推进；多 worker 项目派工和启动须指定 `workerId`。停止默认等当前数学轮结束，`force: true` 才请求立即停止。`workerStop` 是当次回执，最新结清情况看 `workerStopReconciliation`。

- **探索。** main 用 Hana 原生 `subagent`，指定已保存的 App explorer、模型与 `access: "read"`。explorer 不可用时，worker 和 verifier 仍可工作。探索意见须经证明和核验才能成为事实。
- **调配 worker。** `math_project worker_models` 查可用模型和思考强度。`math_assign` 可为本次派工指定 `model`、`thinkingLevel` 和可公开的 `displayTitle`；后台根任务标题以 worker 编号开头。重派省略的字段不沿用上次。`start` 的显式模型与强度逐项覆盖本次派工，不改角色预设；未获思考强度授权则明确拒绝。
- **共享偏好。** 在普通聊天用 `math_project operator_read` 查看，`operator_save` 更新本人愿意跨聊天共享的称呼、语言、时区、通知、USD 告警线和默认 worker 名册；传 `null` 清除一项。不要填密码、联系方式或其他敏感信息。显式 `operatorProfile` 优先，否则新项目复制当时的答案；旧项目不回填。告警线与名册不改变实际预算和 worker 配置。

## 看进展和结果

- **实时看板。** 在主窗口打开与 Code 同级的 Σ「研究看板」。有获准展示的活动项目时，自动跟踪其总览、事实图和共享记忆；不必打开文件或手动绑定。页面隐藏时暂停刷新，重开时重新选项目。事实图可点开证明和前驱；核验记录有对应事实时也可点到证明。
- **结束后。** 无活动项目时，Σ 显示最近一次可信的终态快照，标明项目和结束时间；正常重启后可读回。没有活动项目或可用快照时显示空态；无法确认状态或授权时显示不可用，不扫描旧项目补位。
- **旧项目。** 在原创建会话明确授权或撤回后，用 `math_project dashboard_follow` 或 `dashboard_unfollow` 管理 Σ 的跨重启跟踪，均只传 `projectId`。「当前已保存结果」只在无活动项目、也无优先的可信终态快照时显示，以读取基准时间为准。授权不启动、停止或恢复研究。
- **文档预览。** `.hanamathboard` 仍须在原创建聊天授权绑定当前 Preview，最多 15 分钟。`dashboard_snapshot` 导出的 `.hanamathgraph` 是不刷新的事实图；`graph` 导出的交互 HTML 只含索引和依赖，超出图上限（4096 条事实、32768 条边）时拒绝，不返回残图；Σ 实时看板面对大型事实图（如 3157 条事实、8616 条边）会自动分页拉取索引并在点击节点时按需读取证明，不提高 IPC 额度。`dashboard_overview` 可在聊天中读一次总览。
- **查证明。** 用 `fact_search` 查已验证事实，或用 `math_project result` 加 `factId` 读完整证明。无 ID 时返回一页摘要；沿 `nextCursor` 续读，图变化后从头读。

## 进展报告

创建者用 `summary` 从原题与事实快照生成报告；用 `summary_status` 查看，`summary_result` 取回，`summary_stop` 停止。结果不含写作期间新增的事实；发布前发现采用的事实被撤销或修改时拒绝发布。

干净完成的报告可取 Markdown 和离线 HTML。若 HTML 需要外部资源，则保留 Markdown 并说明未附 HTML 的原因。PDF 可在原创建会话把该 HTML 交给 Host 的 `office_html-to-pdf`，关闭 JavaScript。它与论文的 TeX 编译分开。

## 论文

以下为项目创建者在 `math_project` 中使用的入口，均传 `projectId`。先用 `finalize` 加 `factIds` 选定主结果；省略时只返回建议。`paper_subgraph` 提供事实陈述与依赖骨架，供选材。

| 要做什么 | 入口与结果 |
| --- | --- |
| 直接写初稿 | `paper`，提供 `brief`；输出 `main.tex` 和引用账本。显式 `factIds` 最多 64 条，须含全部主结果。目标及其前驱合计达 10 条时必须精选，不能全选 |
| 规划、逐节写、拼稿 | `paper_plan` 生成线性计划；`paper_section` 每次传 `planReportId`，续写时另传 `previousSectionReportId`。到末节返回 `no_next_section`。用 `paper_stitch` 指定 `planReportId` 与 `finalSectionReportId`，导出同一条链的 `main.tex` |
| 查引文 | `paper_audit` 支持已结算的整篇源稿、修订提案（`proposal.tex`）、章节树（`paper-chapter-tree`）或指定拼稿链（`planReportId` + `finalSectionReportId`）；`paper_verify` 以审计报告为输入在线核验未查实条目，未查实仍标为未确认，原稿与旧账本不变 |
| 改稿 | `paper_revise` 支持四种模式：默认引用修订（承接核验后的账本）、`mode: operator-notes`（按作者意见定点修改源稿/拼稿链/章节树）、`mode: gap-fill`（针对 `wrong` 数学审稿报告仅用已核验 `factIds` 补证明并把新增 `external_refs` 记为未核验；空 `factIds` 配 `missingBacking` 时零模型调用返回 `needs_research`）、`mode: compile-fix`（仅按 `compileLog` 做最小编译修复）。结果均为独立提案，旧稿不覆盖；无改动时返回 `no_edits_applied` |
| 全文数学审稿 | `paper_verify_math` 传 `projectId`，再选 `reportId`（已结算的整篇源稿、产出 `proposal.tex` 的修订提案、章节树，或已结算的引用核验报告以使用其更新后账本）或 `planReportId` 加 `finalSectionReportId`（指定拼稿链）。不接受外部文件路径或自带账本。用 `paper_verify_math_result` 和返回的审稿报告 ID 取 `MATH_REVIEW.json` |
| 编译论文 PDF | `paper_compile` 使用 Math 设置中配置（或自动探测）的本机 `pdflatex` / `pdftex`，在私有隔离目录内执行双遍加固编译（`-no-shell-escape`、`openin_any=p`、`openout_any=p`、`-recorder`）并校验 `main.log`、`main.fls` 与 `main.pdf`，归档不可变 `paper-compile` 报告（含 `main.pdf` 与 `COMPILE_LOG.txt`）；失败时返回可喂给 `paper_revise`（`mode: compile-fix`）的日志摘要 |
| 交付门禁 | `paper_deliver` 校验稿件与已结算 `MATH_REVIEW.json` 的同版哈希绑定。`wrong` 结论默认拦截交付；创建者可显式传 `override: { reason }` 例外放行，并在交付副本的 `\end{document}` 前插入可见 `\note{[math-override] ...}` 披露（不改动归档原稿），`DELIVERY_MANIFEST.json` 如实记录全部 `must-fix` 与 `ignorable` 意见。传入同版已通过的 `compileReportId` 时输出 `compileStatus: passed`、`deliverOk: true` 并附 `main.pdf`；未提供编译证据时如实标 `compileStatus: not-run`、`deliverOk: false`（传 `allowUncompiledTex: true` 可导出 TeX、账本、审稿与清单）；永不授权外发投稿 |
| 章节树组装 | `paper_chapter_tree_stitch` 将主稿 `host` 与按依赖排序的章节 `chapters` 机械组装为不可变 `paper-chapter-tree` 报告：自动剥离章节壳、降级标题、`chapterId:` 命名空间防标签冲突、在 `\usepackage{hyperref}` 前插入新增宏包、拒绝宏冲突与重名标签、替换主稿指针证明、仅保留正文引用的 `\bibitem` 并汇总接缝清单；自定义作者文风规则须传 `confirmedStyleRules: { confirmedByOperator: true, rules }`。返回的 `reportId` 可直接接 `paper_revise`、`paper_audit`、`paper_verify`、`paper_verify_math` 与 `paper_deliver` |

报告类入口有对应的 `_status`、`_result` 和 `_stop`（修订提案用 `paper_revision_*`）。查询与取回报告时用 `projectId` 和该报告自己的 `reportId`。重取附件不重跑模型。`isError:false` 仅代表本次读取完成，还要检查报告状态、错误和附件。`readError` 是本次读取错误，`archiveError` 是归档问题。容量不足时看 `RESEARCH_RUNTIME_CAPACITY`；如有 `managedIpcRefusal`，`current` 表示本次，`recorded` 表示历史原因。

全文审稿使用独立、无工具和无记忆的会话，只读该版 TeX 与账本，不看事实图。`must-fix` 会阻止该版通过，`ignorable` 单列；运行失败不判通过，也不会替稿件补证明。引文核验、数学审稿和 TeX 编译分别判断。当前 App 支持在隔离工作目录内执行受管 TeX 编译，但不负责投稿和发布。

## 排查

- `math_project doctor` 仅绑定的 main 可调用，只读；`unknown` 不作为可恢复的证明。
- `math_project recheck` 仅创建者可对带恢复标记的指定终态 run 调用，需 `projectId`、`workerId`、`runId`。它可能清理任务或会话，但不重跑研究；尝试次数不等于成功次数。没有恢复标记时返回 `RECHECK_NOT_NEEDED`。
- 真实研究数据只走授权接口。模型凭据由 Hana 管理；App 不自动发布论文或推送 Git。
