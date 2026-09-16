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

验证关键字补全时，打开并保存 `.v` 或 `.sv` 文件，确认语言模式分别为 Verilog 或 SystemVerilog，输入 `alw`、`pos` 等前缀后按 `Ctrl+Space`。SystemVerilog 文件还应提供 `always_ff`、`always_comb`、`logic` 等候选。

## 文档与反馈

- [本仓库文档](docs/)
- [问题反馈](https://github.com/narutozxp/vscode-terosHDL/issues)
- [上游 TerosHDL 使用文档](https://terostechnology.github.io/terosHDLdoc/)，可作为共有功能的参考。

## 致谢

感谢 [Teros Technology](https://github.com/TerosTechnology) 及 [TerosHDL 原仓库](https://github.com/TerosTechnology/vscode-terosHDL) 的维护者与贡献者。本项目的基础功能和架构来自其开源工作。

## 许可证

沿用原项目的 [GNU GPL v3 许可证](LICENSE)。源文件中的原作者版权声明予以保留。
