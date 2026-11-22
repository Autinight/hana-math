# Hana Math

Hana Math 将 [Danus](https://github.com/frenzymath/Danus) 的数学研究流程接入 HanaAgent：main 分派任务，worker 提交候选证明，独立 verifier 审阅，被接受的事实进入项目事实图。模型核验不等于形式化证明。

这是开发仓库提交 `2084f4f`（版本 `0.36.1`）的公开源码快照，使用独立 Git 历史。它包含 Hana Math 的应用代码、Python 引擎、构建脚本和软件测试。使用说明见 [Hana Math 用户指南](packages/hana-math/README.md)，引擎说明见 [engine/README.md](engine/README.md)。源码中已有 Windows 适配工作，不代表 Windows 安装包已经通过真机验收。

## 使用与构建边界

- 这是源码快照，不附可安装的 ZIP、研究数据、对话、内部开发记录或验收产物。部分脚本和开发文档链接指向原开发环境，仅适用于完整开发检出。
- 未随快照再分发 HanaAgent beta SDK、对应预构建 UI 库或个人头像。开发完整 App 需自行从有权使用的 HanaAgent 开发环境提供匹配版本的 `packages/hana-math/sdk/`、`packages/hana-math/ui/assets/{sdk.js,app-ui.js,app-ui.css}` 和所用头像资源。构建安装包还需独立提供匹配平台的 Python 运行时。未在这份公开快照上验证端到端 App 构建。
- 引擎使用 Python 3.12；在仓库根可单独测试：`cd engine && PYTHONPATH=src python3.12 -B -m unittest discover -s tests`。

## 上游许可

保留随相关代码附带的许可证与署名：Danus 见 [引擎许可证](engine/LICENSE) 和 [随包上游许可证](packages/hana-math/references/danus/LICENSE)；看板、数学渲染库及字体见各自目录内的 LICENSE、NOTICE 或 `licenses/` 文件。
