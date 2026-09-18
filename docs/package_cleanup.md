# 离线发布包精简

本轮保留 Yosys、Pyodide、解析器 WASM、Python wheel、语言服务器、ctags、格式化工具和图标，不增加运行时下载。

## 已完成

- 将独立 CLI 的 oclif、类型声明和构建插件移到开发依赖；CLI 源码和开发运行方式保留，VSIX 排除 `bin` 和编译后的 CLI 命令。
- 删除未被当前测试配置使用的 `jest-html-reporter`，保留正在使用的 `jest-html-reporters`。
- 移除重复的开发依赖 `js-yaml`，保留运行依赖版本，防止 VSCE 将工程配置所需的 YAML 库排除。
- 同步修改 `auto_package` 依赖模板，避免重新生成清单时恢复旧配置。
- 排除测试报告、覆盖率、构建脚本和根目录测试脚本。
- SQL.js 只发布当前 Node 入口 `sql-wasm.js` 和对应 `sql-wasm.wasm`，保留包元数据及许可证，排除其他构建产物。
- 两个 Webview 共享已有 `resources/viz/full.render.js`，删除完全相同的副本。其他 Viz 文件内容不同，未合并；状态机模板补齐缺失的 Viz URI 绑定。
- 删除引用不存在的旧 `teroshdl2/node_modules/onml` 的打包修补脚本，正式及预发布打包直接调用 VSCE。
- 前一轮删除的旧 docs 图片及网页继续保持清理状态。

## 体积与验证

使用 VSCE 发布清单及最终 VSIX 内容测量，同一工作区精简前约 **14,119 个文件、290.21 MiB**，精简后约 **10,066 个扩展文件、182.31 MiB**，未压缩内容减少约 **107.90 MiB（37%）**。数字是包内文件大小之和，不是磁盘分配空间。基线在前一轮 docs 清理之后；最终体积包括恢复正确分类的 YAML 运行依赖和本说明文件。

测试 VSIX 的压缩体积约 **51.2 MiB**。没有对应精简前 VSIX 的压缩体积，不以未压缩节省量推断下载节省量。

TypeScript 编译、234 项语言服务测试和差异检查通过。YAML 分类修正后另有 4 个工程/配置套件、65 项测试通过；两个旧配置夹具补齐默认字段，解决测试缺少 `indexing_scope`/`live_parsing` 的编译错误。清单比较确认原有 108 个原生工具、解析器及 Python 资源全部保留；Node 依赖状态刷新后，发布清单不再包含 Jest、TypeScript 或 oclif。

VSIX 解包到开发工作区之外，运行下面的检查：

```sh
node tests/packaging/offline_smoke.cjs /absolute/path/to/extracted/extension
```

检查阻断 Node 的 fetch、HTTP、HTTPS、网络连接接口，Parser Worker 继承相同检查。验证包内运行依赖可解析、SQLite 查询、YAML 配置读写、实时解析 Worker/WASM、Graphviz 渲染、Pyodide 基础 Python 与标准库、Yosys 简单综合及两个 Webview 的全部脚本/样式资源路径。

这不是完整编辑器 GUI 回归，也不覆盖所有 Python 第三方包或外部工具配置；没有对操作系统或所有原生进程实施网络隔离。它验证被裁剪或共享的资源及关键内置运行时，不宣称所有工程配置均已离线验证。

## 后续方向

平台二进制拆包、主扩展代码 bundling 和更多依赖内部裁剪可继续减小体积，但需要分别验证远程主机平台、动态加载及资源路径。本轮未实施，避免在没有验证的情况下影响离线功能。
