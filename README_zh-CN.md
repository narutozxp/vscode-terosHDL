> 本项目基于 [TerosHDL 原仓库](https://github.com/TerosTechnology/vscode-terosHDL) 修改，是由 `narutozxp` 维护的派生版本。

[English](README.md) | **简体中文**

# ZHDL

![ZHDL 图标](resources/images/zhdl-icon.png)

面向 ASIC / FPGA 开发的 VS Code 扩展，提供 Verilog、SystemVerilog 和 VHDL 编辑、项目管理及工具集成。

## 8.0.10 版本更新

- 配置、项目存储、Output 通道、菜单命令和视图使用 ZHDL 独立命名。
- 索引范围和试验性实时解析移入 **Open Global Settings Menu → General**，优化英文说明与控件对齐。
- 英文作为主 README，提供中文 README，补充配置迁移、性能限制与后续 TODO。
- 移除临时诊断启动配置与运行时钩子，本地调试使用 **Run ZHDL**。

升级后如需保留旧设置，请手动导入，并更新自定义快捷键中的命令名，详见[配置文件位置](#配置文件位置)。

## 当前开发更新（尚未发布）

- 编辑传输和文本存储改为增量处理，赋值、声明、模块头和受影响模块采用分层提取。
- 支持读取其他已打开工程成员的未保存接口，完善虚拟文档处理及符号位置范围。
- 精简离线发布包：排除开发依赖和未使用的 SQL.js 构建，复用重复渲染资源，清理旧文档素材。
- 增加编辑/撤销、生命周期和大输入回归，以及解包后 VSIX 的离线资源检查。

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
- 全局配置、项目列表、构建目录、日志通道及菜单命令使用 ZHDL 独立命名，避免与原 TerosHDL 共用设置或发生标识冲突。

## 模块实例化与端口补全

索引优先使用包含当前文件的 ZHDL 工程文件列表；没有对应工程时，默认只索引当前打开的 Verilog / SystemVerilog 文件，打开多个文件时可在这些文件之间补全模块，关闭文件后移除其模块。

在插件的 **Open Global Settings Menu → General** 中设置索引范围和实时解析。这两项保存在 `~/.zhdl_config.json` 的 `general.general` 下，例如：

```json
{
  "general": {
    "general": {
      "indexing_scope": "openFiles",
      "live_parsing": false
    }
  }
}
```

`indexing_scope` 的 `openFiles` 为默认值；改为 `workspace` 时，索引当前文件所属的 VS Code 工作区文件夹。工作区扫描包含 `.v`、`.sv`、`.vh`、`.svh`，排除 `node_modules`、`.git`、`out`、`dist` 和 `build` 目录；文件未加入工作区时只索引自身。在插件全局设置菜单保存后立即生效；直接修改配置文件需重新加载窗口。项目设置页面中的同名字段不覆盖这两项全局设置。

上述 JSON 仅展示相关字段，手动修改时请保留配置文件中的其他设置。原 VS Code `settings.json` 中的 `zhdl.indexing.scope` 和 `zhdl.indexing.liveParsing` 已不再读取，可删除并在插件全局设置中重新设置。

在模块体内的空行输入模块名，选择补全候选后，会生成带命名参数和端口的实例，每个端口后附方向和位宽注释，例如 `// input [WIDTH-1:0]`，单比特显示 `[0:0]`。无法推断的自定义类型宽度标为 `width unknown`。首先用 **Tab** 编辑实例名，再依次编辑参数值和端口连接。在已有实例连接列表中输入 `.`，可补全尚未连接的端口；参数覆盖列表 `#(...)` 中可补全参数。输入 `u_instance.` 可补全该实例的模块端口。在 `.port(...)` 的表达式内部，仍使用当前模块的信号补全。

保存的 ctags 符号和磁盘模块接口在保存或文件变化后更新；当前文件的模块接口和补全上下文读取编辑缓冲区。启用实时解析后，其他已打开且未保存的工程成员也提供当前接口，包括 `.vh`、`.svh` 成员；干净文件复用保存索引，不相关的打开文件不混入工程。索引使用语法解析，不执行 HDL 预处理或 elaboration，宏生成的模块接口可能无法完整提取。首次补全会等待工程索引，后续请求复用缓存。

### 未保存内容的增量补全（试验）

在插件全局设置的 **General** 页面启用 `live_parsing`，可试用未保存的 Verilog / SystemVerilog 信号补全与 Outline 更新；默认关闭。

编辑通过文档变更事件触发更新，采用 30～100 ms 的自适应合并延时；从一批首次修改起，最长等待 150 ms 后提交请求。补全、Outline 和工程接口查询会立即提交待处理更新。这是调度等待时间，Worker 排队和执行还需要额外时间；没有定时轮询。

打开文件共享一个按需启动的后台 Worker。正常编辑只发送变更范围及新增文本，保留旧语法树并更新受影响符号。同一文件最多一个请求在途，解析期间的新编辑会继续累积，随后追赶最新版本。关闭文件释放状态并跳过尚未执行的请求，全部关闭后终止 Worker；已经进入 WASM 的任务无法单独中断。

安全的赋值表达式编辑跳过外围声明遍历；声明、过程项、函数/任务和 generate 编辑尽可能局部提取。ANSI 端口和名称不变的头部参数编辑可以只提取模块头。参数名称变化、non-ANSI 接口协调可能需要提取受影响模块；设计单元边界变化及语法错误恢复可能完整提取。完整提取不代表必须重新传输全文。

实时符号主要覆盖 module、port、register、net、instance、constant。其他 ctags 种类仍来自已有保存缓存，未保存时可能过期；函数和块的可见性尚不是完整的 SystemVerilog 作用域模型。虚拟文档支持本地实时补全与 Outline，不具备完整的文件工程索引。宏与 include 不做语义展开，修改头文件不能可靠更新全部引用文件的预处理语义。关闭此设置即可恢复保存文件的符号补全流程。

本地基准使用 Node.js 25.8.1，主样例为含 10,000 条声明的合成模块，约 229,050 个 UTF-16 字符。下表为连续 10 次编辑的请求往返中位数，包含 Worker 执行、消息传输和主线程差量合并，不包含调度延时、工程首次索引、完整补全项构造或 VS Code 界面渲染：

| 编辑类型 | 请求往返中位数 |
|---|---|
| 声明位宽 | 10.44 ms |
| 过程赋值表达式 | 7.81 ms |
| ANSI 端口方向 | 9.38 ms |
| 头部参数默认值 | 11.97 ms |
| generate 条件 | 9.10 ms |

包含 Worker 启动的首次分析单次测量约 693 ms。另一个包含 100 个模块、每模块 100 条声明的文件，模块体参数编辑约 7.28 ms；不能据此推断单个巨大模块的参数编辑成本。这些连续编辑场景中，Buffer 服务的全文读取次数均为 0；补全提供者本身仍需要读取文本以判断上下文。

回归矩阵覆盖 122 类编辑及撤销，另有版本恢复、文档生命周期、Unicode 坐标、深层嵌套和巨大声明检查。与首次解析对照证明增量结果一致，不代表完整 HDL 编译语义正确。大型真实工程的峰值内存和端到端界面性能仍需验证，因此继续保留试验标记、默认关闭。详见[架构评估与剩余限制](docs/live_parsing_review.md)。

### 语法检查刷新

配置并启用相应 linter 后，编辑内容也会触发诊断更新，不要求先保存；当前编辑事件合并等待约 250 ms，打开和保存文件也会触发检查。检查由外部工具执行，通常需要处理完整内容，其开销独立于上述 Tree-sitter 增量补全。工具路径、启用状态和执行耗时会影响诊断何时出现。

## 内置工具版本

- Verible LSP：`v0.0-4219-g3275ab72`，包含 Linux x86_64 和 Windows x64 二进制。
- Universal Ctags：`6.2.0 (ab95af1)`，采用官方 2026-09-16 nightly 构建，包含 Linux x86_64、macOS Intel 和 Windows x86 二进制。
- 版本、下载来源及 SHA-256 记录在 `server/binaries.json`。运行 `python3 server/update_binaries.py` 可重新下载并安装这些固定版本；更新版本时需同步修改该清单。

## 离线使用与发布包体积

解析器、Yosys、Pyodide、SQL.js、Python wheel 和内置原生工具继续随 VSIX 提供，本次精简不增加运行时下载。请在运行扩展的环境中安装兼容的 VSIX；Remote SSH、WSL 和容器中的工具路径及二进制兼容性以远端环境为准。GHDL、Verilator、Vivado、Quartus 等外部工具的集成需要提前在该环境中安装并配置，才能离线使用。在线文档及额外包下载仍需联网。

本地测量的发布内容从约 290 MiB 降到 182 MiB，未压缩体积减少约 37%；测试 VSIX 压缩后约 51.2 MiB。数字不是所有发行版本的体积保证。清理范围包括开发依赖、未使用的 SQL.js 版本、重复渲染库和旧文档资源，现有图标及离线运行资源保留。详见[精简记录与验证范围](docs/package_cleanup.md)。

## 配置文件位置

全局配置和项目列表保存在运行插件的用户主目录下：

| 文件 | 用途 |
|---|---|
| `~/.zhdl_config.json` | 全局设置，包括工具路径、linter、格式化等配置 |
| `~/.zhdl_prj.json` | 项目列表及项目数据 |

Linux / macOS 中，`~` 表示当前用户的主目录；Windows 中对应 `%USERPROFILE%`，例如 `C:\Users\用户名\.zhdl_config.json`。使用 Remote SSH、WSL 或容器开发时，这些文件位于运行插件的远端环境或容器内的用户主目录。

ZHDL 独立使用以上文件，不再自动读取或写入 TerosHDL 的 `~/.teroshdl2_config.json` 和 `~/.teroshdl2_prj.json`。首次切换到独立配置时，工具路径等设置需要重新配置；需要保留旧设置时，可在 ZHDL 全局设置菜单中使用 **Load Settings** 选择旧的 `.teroshdl2_config.json`，之后保存到 ZHDL 自己的配置文件。也可先通过 **Export Settings** 导出备份。

需要迁移原项目列表时，关闭相关扩展宿主，备份现有 `.zhdl_prj.json`，再将 `.teroshdl2_prj.json` 复制为 `.zhdl_prj.json`；项目格式保持兼容，原文件无需删除。迁移后两份数据独立维护。

工具默认构建目录为 `~/.zhdl/build`，主目录中的临时文件使用 `.zhdl_` 前缀，工作区缓存使用扩展自己的存储目录。安装状态文件为扩展安装目录内的 `user.zhdl.config.json`，仅记录安装与版本状态，不是全局工具设置。

Output 面板的通道为 **ZHDL: Global**、**ZHDL: Tool Manager** 和 **ZHDL: Debug**。菜单命令及项目视图也使用独立的 `zhdl` 标识；已有自定义快捷键若引用 `teroshdl.*` 命令，需要改为对应的 `zhdl.*`。

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

安装 VSCE 后构建 VSIX：

```bash
npm install -g @vscode/vsce
npm run package
```

打包会执行现有示例刷新和编译步骤；构建期间刷新上游示例需要 Git 和网络，与安装后的离线运行分开。解压生成的 VSIX 后，可验证随包资源：

```bash
node tests/packaging/offline_smoke.cjs /absolute/path/to/extracted/extension
```

检查使用解包目录，阻断 Node 网络接口（解析 Worker 继承同样检查），验证 SQLite、YAML、解析、Graphviz、基础 Python/标准库、Yosys 和 Webview 资源绑定；不是完整 VS Code 界面回归或操作系统级网络隔离测试。

验证关键字补全时，打开并保存 `.v` 或 `.sv` 文件，确认语言模式分别为 Verilog 或 SystemVerilog，输入 `alw`、`pos` 等前缀后按 `Ctrl+Space`。SystemVerilog 文件还应提供 `always_ff`、`always_comb`、`logic` 等候选。

## TODO

- [ ] 缓存模块内各声明的提取贡献，完善局部错误恢复，减少参数名称变化、non-ANSI 接口和语法错误编辑后的模块/完整提取。
- [ ] 建立更细的作用域图，完善 SystemVerilog 函数、任务、class、interface、package 等实时符号与可见性。
- [ ] 分别提取离散编辑区间，评估延迟计算位置，降低剩余的符号数组和行索引线性更新成本。
- [ ] 统一保存文件、编辑缓冲区和工程索引的解析缓存，减少重复解析，将工程首次分析中的耗时工作移出扩展主线程。
- [ ] 将未保存符号接入悬停与跳转定义，统一消费者的版本与作用域；实现预处理和宏/include 的传递依赖失效。
- [ ] 增加工程/WASM 内存预算、缓存淘汰和任务优先级；测试长期编辑、反复打开关闭、快速连续编辑及实际界面响应，再评估是否默认启用实时解析。
- [ ] 评估分平台离线包和扩展代码打包，同时保留动态加载、Worker 入口及运行资源。
- [ ] 升级 `web-tree-sitter` 前重新构建并验证匹配的 HDL WASM 语法包，完成 API 与导入方式迁移；当前旧 WASM 不能直接配合已测试的新版本使用。
- [ ] 优化 linter 调度：限制同一文件的并发检查、丢弃过期诊断，补齐任务取消、超时、异常与临时文件清理，并评估可配置的刷新间隔。
- [ ] 验证 Axios 在扩展宿主中的 `navigator` 兼容性，评估 Sandpiper 等可选工具的按需加载，减少启动期间依赖加载和警告。
- [ ] 继续排查开发窗口退出：收集客户端退出日志及真实遥测调用堆栈，对比隔离启动和关闭调试器网络检查的结果，进行长期内存与连接监测。
- [ ] 提供旧配置与项目列表的迁移向导，包含导入确认、备份和错误反馈，简化当前手动迁移流程。
- [ ] 完善测试隔离与资源清理：配置、项目管理和解析回归分组运行通过，但合并运行曾出现解析超时，配置回归结束后仍有未释放句柄。

## 文档与反馈

- [实时解析架构、基准与限制](docs/live_parsing_review.md)
- [离线包精简及检查](docs/package_cleanup.md)
- [本仓库文档](docs/)
- [问题反馈](https://github.com/narutozxp/vscode-terosHDL/issues)
- [上游 TerosHDL 使用文档](https://terostechnology.github.io/terosHDLdoc/)，可作为共有功能的参考。

## 致谢

感谢 [Teros Technology](https://github.com/TerosTechnology) 及 [TerosHDL 原仓库](https://github.com/TerosTechnology/vscode-terosHDL) 的维护者与贡献者。本项目的基础功能和架构来自其开源工作。

## 许可证

沿用原项目的 [GNU GPL v3 许可证](LICENSE)。源文件中的原作者版权声明予以保留。
