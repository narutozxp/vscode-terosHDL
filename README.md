> 本项目基于 [TerosHDL 原仓库](https://github.com/TerosTechnology/vscode-terosHDL) 修改，是由 `narutozxp` 维护的派生版本。

# ZHDL

![ZHDL 图标](resources/images/zhdl-icon.png)

面向 ASIC / FPGA 开发的 VS Code 扩展，提供 Verilog、SystemVerilog 和 VHDL 编辑、项目管理及工具集成。

## 功能

- 语法高亮、代码片段与模板生成。
- Verilog / SystemVerilog 关键字补全，以及已有的符号补全。
- 跳转定义、悬停提示、层次结构与依赖查看。
- 语法检查、Verible 风格检查与代码格式化。
- HDL 文档生成、原理图查看与状态机工具。
- 仿真器及综合工具集成，包括 GHDL、Verilator、Icarus Verilog、Yosys、Vivado、Quartus、VUnit、cocotb 等。

## 本分支修改

- 按文件语言提供 Verilog 和 SystemVerilog 关键字补全。
- 修复 ctags 尚未解析当前文件时，补全请求不返回的问题。
- 使用当前扩展上下文读取安装目录及版本信息，支持修改插件名称和发布者。
- 再次打开设置菜单时，显示已有的设置页面。
- 保留 ctags 大纲，避免与 Verible 的符号列表重复显示。
- Verible 不支持悬停时启用 ctags 后备悬停提示。
- 补全项名称旁显示信号类型和位宽，端口显示方向、类型和位宽，例如 `input wire [WIDTH-1:0]`；Outline 使用相同的信号详情，实例显示对应模块名，并使用 Field 图标区分实例与变量。
- 补全按光标所在模块过滤端口、变量等符号，避免同一文件中其他模块的符号混入；模块名及关键字仍可补全。
- 文件符号使用独立缓存，共享并发请求；保存或磁盘文件变化后更新，工程索引仅重新解析发生变化的文件。
- 支持工程内跨文件模块补全和实例化模板，以及实例的命名端口、参数和层次端口补全。

## 开发窗口诊断

排查 F5 开发窗口中的依赖警告、遥测输出或退出问题时，可选择调试配置 `Run ZHDL (diagnostic)`。配置同时通过 `env` 和 `--extensionEnvironment` 传递开关，以支持远程开发宿主。打开 HDL 文件激活扩展后，控制台会显示诊断日志路径：`[ZHDL diagnostic] /tmp/zhdl-runtime-<PID>.jsonl`（Windows 使用系统临时目录）。日志记录依赖加载来源、警告堆栈、Application Insights 控制台调用来源及每 30 秒的进程内存；对自动发往 Application Insights 的 HTTP 请求只观察目标主机和调用堆栈，不主动发送请求或记录请求体，文件限制为 2 MiB。调试器本身的诊断由 `trace` 开启。

`Run ZHDL (diagnostic, isolated)` 会禁用开发窗口中其他已安装扩展，用于对比输出来源。普通 `Run ZHDL` 不启用这些诊断钩子。远程开发时，运行时诊断文件在远端，客户端窗口的退出原因仍需要客户端 `main.log` / `renderer.log` 判断。

目前的排查结果：远端日志中的连接超时清理发生在客户端断开之后，不能据此判断窗口最初为什么退出。加载 Markdown Preview Enhanced 的独立测试可复现 `punycode` 弃用警告，但此前开发窗口里的警告尚未捕获实际调用堆栈；`ApplicationInsights:Sender` 的具体发送者也待诊断日志确认。另观察到启用调试器网络检查时的 `Missing dataLength in event` 错误，需要单独验证其影响。这些输出目前均不能证明 ZHDL 导致窗口退出。

## 模块实例化与端口补全

索引优先使用包含当前文件的 ZHDL 工程文件列表；没有对应工程时，默认只索引当前打开的 Verilog / SystemVerilog 文件，打开多个文件时可在这些文件之间补全模块，关闭文件后移除其模块。

可在 VS Code 设置中搜索 `ZHDL Indexing Scope`，或在 `settings.json` 中配置：

```json
"zhdl.indexing.scope": "openFiles"
```

`openFiles` 为默认值；改为 `workspace` 时，索引当前文件所属的 VS Code 工作区文件夹。工作区扫描包含 `.v`、`.sv`、`.vh`、`.svh`，排除 `node_modules`、`.git`、`out`、`dist` 和 `build` 目录；文件未加入工作区时只索引自身。配置修改立即作用于后续补全请求。

在模块体内的空行输入模块名，选择补全候选后，会生成带命名参数和端口的实例，每个端口后附方向和位宽注释，例如 `// input [WIDTH-1:0]`，单比特显示 `[0:0]`。无法推断的自定义类型宽度标为 `width unknown`。首先用 **Tab** 编辑实例名，再依次编辑参数值和端口连接。在已有实例连接列表中输入 `.`，可补全尚未连接的端口；参数覆盖列表 `#(...)` 中可补全参数。输入 `u_instance.` 可补全该实例的模块端口。在 `.port(...)` 的表达式内部，仍使用当前模块的信号补全。

ctags 符号和其他文件的模块接口在保存或磁盘变化后更新；当前文件的模块接口和补全上下文读取编辑缓冲区。索引使用语法解析，不执行 HDL 预处理或 elaboration，宏生成的模块接口可能无法完整提取。首次补全会等待工程索引，后续请求复用缓存。

### 未保存内容的增量补全（试验）

在 VS Code 的 `settings.json` 中设置 `"zhdl.indexing.liveParsing": true`，可试用未保存的 Verilog / SystemVerilog 信号补全与 Outline 更新；默认关闭。打开文件共享一个按需启动的后台 Worker，保留每个文件的旧语法树，常见模块体声明编辑只更新相关声明，并传回符号差量。编辑合并等待时间为 30～100 ms，最长等待 150 ms；补全请求会提前执行更新。同一文件最多一个解析请求在途，后续编辑合并到最新版本。关闭文件释放其树，全部关闭后终止 Worker。

模块头、参数、过程块或语法错误等复杂编辑暂时重新提取完整符号，较大文件的延迟和内存开销高于常见声明编辑。这是性能试验，尚未替代工程的 ctags 索引；ctags 独有的符号类型仍来自保存后的缓存，宏与 include 不做语义展开。关闭此设置即可恢复保存文件的符号补全流程。

本地合成文件测试记录如下（Linux、Xeon E5-2680 v4、Node.js 25.8.1、`web-tree-sitter` 0.20.8，每个文件包含四个模块）。时间为常见声明编辑的请求往返中位数，包含 Worker 解析、符号差量传输和客户端缓存更新，不包含编辑合并等待、VS Code 界面渲染或工程初次索引：

| 文件行数 | 符号数量 | 常见声明编辑 |
|---|---|---|
| 220 | 120 | 约 2 ms |
| 2,020 | 1,020 | 约 3 ms |
| 20,020 | 10,020 | 约 23 ms |

两万行文件在独立压力测试中，包含 Worker 启动的首次分析约 1.2 秒，修改模块头或产生不完整语句约 0.55～0.61 秒。后者的主要开销是完整模块信息与符号提取，增量语法解析本身约 20～23 ms。连续编辑时测试进程总 RSS 约 400～436 MiB，包含主线程、Worker 和 WASM 内存；该数据不是 Worker 的独占内存，也不能作为长期无泄漏的结论。因此此功能继续默认关闭，实际开发宿主表现仍需验证。

### 语法检查刷新

配置并启用相应 linter 后，编辑内容也会触发诊断更新，不要求先保存；当前编辑事件合并等待约 250 ms，打开和保存文件也会触发检查。检查由外部工具执行，通常需要处理完整内容，其开销独立于上述 Tree-sitter 增量补全。工具路径、启用状态和执行耗时会影响诊断何时出现。

## 内置工具版本

- Verible LSP：`v0.0-4219-g3275ab72`，包含 Linux x86_64 和 Windows x64 二进制。
- Universal Ctags：`6.2.0 (ab95af1)`，采用官方 2026-09-16 nightly 构建，包含 Linux x86_64、macOS Intel 和 Windows x86 二进制。
- 版本、下载来源及 SHA-256 记录在 `server/binaries.json`。运行 `python3 server/update_binaries.py` 可重新下载并安装这些固定版本；更新版本时需同步修改该清单。

## 配置文件位置

全局配置和项目列表保存在运行插件的用户主目录下：

| 文件 | 用途 |
|---|---|
| `~/.teroshdl2_config.json` | 全局设置，包括工具路径、linter、格式化等配置 |
| `~/.teroshdl2_prj.json` | 项目列表及项目数据 |

Linux / macOS 中，`~` 表示当前用户的主目录；Windows 中对应 `%USERPROFILE%`，例如 `C:\Users\用户名\.teroshdl2_config.json`。使用 Remote SSH、WSL 或容器开发时，这些文件位于运行插件的远端环境或容器内的用户主目录。

当前 ZHDL 沿用原 TerosHDL 的文件名和保存位置。同一环境、同一用户下，两个插件会共享这些文件；仅修改插件名称或发布者不会隔离配置，因此修改设置可能影响另一个插件。可以通过设置菜单中的 **Export Settings** 和 **Load Settings** 导出、加载配置。

## 本地开发

需要 Node.js 22、npm、Python 3 和 Git。在仓库根目录依次执行：

```bash
npm install
npm run compile
```

在 VS Code 的“运行和调试”中选择 **Run ZHDL**，按 **F5** 启动扩展开发宿主。该配置会启动编译监视任务；修改源码并编译完成后，在开发宿主窗口执行 **Developer: Reload Window**。

检查与测试：

```bash
npx tsc -p ./ --noEmit
npm test
npm run lint
```

本次语言服务和解析器回归可单独运行：

```bash
npm run compile
node node_modules/jest/bin/jest.js tests/teroshdl tests/parser --runInBand --coverage=false --reporters=default
```

Worker 测试使用 `out` 中的编译产物，修改源码后需先编译。`npm run compile` 已包含资源复制和两组 Webview 构建，不需要再分别执行这些命令。

验证关键字补全时，打开并保存 `.v` 或 `.sv` 文件，确认语言模式分别为 Verilog 或 SystemVerilog，输入 `alw`、`pos` 等前缀后按 `Ctrl+Space`。SystemVerilog 文件还应提供 `always_ff`、`always_comb`、`logic` 等候选。

## TODO

- [ ] 优化模块头、参数和语法错误编辑：按模块缓存接口与符号，局部恢复不完整声明，减少完整文件提取造成的长延迟。
- [ ] 扩展增量处理到过程块、函数和任务，并完善 SystemVerilog 的 class、interface、package 等作用域与符号识别。
- [ ] 直接利用编辑事件中的变更范围，减少完整文本比较、符号数组复制和后续位置移动；评估紧凑存储及延迟计算位置。
- [ ] 统一保存文件、编辑缓冲区和工程索引的解析缓存，减少重复解析，将工程首次分析中的耗时工作移出扩展主线程。
- [ ] 将未保存符号接入悬停与跳转定义，统一补全、Outline、悬停和跳转所用的版本及作用域；评估宏和 include 的工程解析支持。
- [ ] 增加大文件与多文件内存预算、缓存淘汰和任务优先级；测试长期编辑、反复打开关闭、快速连续编辑及实际界面响应，再评估是否默认启用实时解析。
- [ ] 升级 `web-tree-sitter` 前重新构建并验证匹配的 HDL WASM 语法包，完成 API 与导入方式迁移；当前旧 WASM 不能直接配合已测试的新版本使用。
- [ ] 优化 linter 调度：限制同一文件的并发检查、丢弃过期诊断，补齐任务取消、超时、异常与临时文件清理，并评估可配置的刷新间隔。
- [ ] 验证 Axios 在扩展宿主中的 `navigator` 兼容性，评估 Sandpiper 等可选工具的按需加载，减少启动期间依赖加载和警告。
- [ ] 继续排查开发窗口退出：收集客户端退出日志及真实遥测调用堆栈，对比隔离启动和关闭调试器网络检查的结果，进行长期内存与连接监测。
- [ ] 评估独立的 ZHDL 配置文件命名与旧 TerosHDL 配置迁移，避免两个扩展共享设置造成相互影响。

## 文档与反馈

- [本仓库文档](docs/)
- [问题反馈](https://github.com/narutozxp/vscode-terosHDL/issues)
- [上游 TerosHDL 使用文档](https://terostechnology.github.io/terosHDLdoc/)，可作为共有功能的参考。

## 致谢

感谢 [Teros Technology](https://github.com/TerosTechnology) 及 [TerosHDL 原仓库](https://github.com/TerosTechnology/vscode-terosHDL) 的维护者与贡献者。本项目的基础功能和架构来自其开源工作。

## 许可证

沿用原项目的 [GNU GPL v3 许可证](LICENSE)。源文件中的原作者版权声明予以保留。
