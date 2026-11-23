# Hana Math

Hana Math 将 [Danus](https://github.com/frenzymath/Danus) 的数学研究流程接入 HanaAgent：main 分派任务，worker 提交候选证明，独立 verifier 审阅，通过的事实进入项目事实图。模型核验不等于形式化证明。

- [开始使用](packages/hana-math/README.md)：研究、看板、报告、论文导出与全文数学审稿。
- [Python 引擎](engine/README.md)：运行环境与开发说明。

全文审稿意见绑定到指定稿件和引用账本。软件测试不代表已用真实模型验收；论文 TeX 编译和 Windows 真机运行未在本版本验证。

## 开发

这里提供 App 源码、Python 引擎、构建脚本和软件测试。安装包、研究数据和本机验收产物不入库。构建 App 需从有权使用的 HanaAgent 开发环境提供匹配版本的 SDK、预构建 UI 库、所用头像资源，以及目标平台的 Python 运行时。

在仓库根目录可单独测试 Python 引擎：`(cd engine && PYTHONPATH=src python3.12 -B -m unittest discover -s tests)`。

## 上游许可

保留随相关代码附带的许可证与署名：Danus 见 [引擎许可证](engine/LICENSE) 和 [随包上游许可证](packages/hana-math/references/danus/LICENSE)；看板、数学渲染库及字体见各自目录内的 LICENSE、NOTICE 或 `licenses/` 文件。
