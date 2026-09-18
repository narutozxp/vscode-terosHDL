> ZHDL is a fork of [TerosHDL](https://github.com/TerosTechnology/vscode-terosHDL), modified and maintained by `narutozxp`.

**English** | [简体中文](README_zh-CN.md)

# ZHDL

![ZHDL icon](resources/images/zhdl-icon.png)

A VS Code extension for ASIC and FPGA development, with Verilog, SystemVerilog and VHDL editing, project management and tool integration.

## Version 8.0.10

- Independent ZHDL configuration, project storage, output channels, commands and views.
- Indexing scope and experimental live parsing configured through **Open Global Settings Menu → General**, with clearer English labels and aligned controls.
- English main README and a [Chinese README](README_zh-CN.md), including configuration migration, performance limits and remaining TODOs.
- Removed the temporary diagnostic launch configurations and runtime hooks. Use **Run ZHDL** for local debugging.

After upgrading, import old settings if needed and update custom keybindings to the new command names. See [Configuration file locations](#configuration-file-locations).

## Features

- Syntax highlighting, snippets and template generation.
- Verilog and SystemVerilog keyword and symbol completion.
- Go to definition, hover information, hierarchy and dependency views.
- Syntax checking, Verible style checking and code formatting.
- HDL documentation, schematic viewing and state machine tools.
- Integration with simulation and synthesis tools, including GHDL, Verilator, Icarus Verilog, Yosys, Vivado, Quartus, VUnit and cocotb.

## Changes in this fork

- Language-specific Verilog and SystemVerilog keyword completion.
- Completion requests return even when ctags has not indexed the current file.
- Installation paths and version information come from the current extension context, allowing the extension name and publisher to change.
- Opening the settings menu again brings the existing settings page to the front.
- The ctags outline is retained to avoid duplicate symbols from Verible.
- A ctags hover provider is enabled when Verible does not support hover.
- Completion labels show signal types and widths. Ports show direction, type and width, such as `input wire [WIDTH-1:0]`. Outline entries show the same signal details; instances show their module name and use the Field icon.
- Ports and variables are filtered by the module containing the cursor. Module names and keywords remain available.
- Per-file symbol caches share concurrent requests and update after saves or disk changes. Project indexing reparses only changed files.
- Cross-file module completion, instantiation templates, named port and parameter completion, and hierarchical port completion.
- Separate ZHDL names for configuration files, project lists, build directories, output channels, commands and views.

## Module instantiation and port completion

The index first uses the ZHDL project containing the current file. Without a matching project, it defaults to the currently open Verilog and SystemVerilog files. Opening multiple files enables module completion between them; closing a file removes its modules from that index.

Configure indexing and live parsing under **Open Global Settings Menu → General**. Both settings are stored under `general.general` in `~/.zhdl_config.json`:

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

`indexing_scope` defaults to `openFiles`. Select `workspace` to index the VS Code workspace folder containing the current file. Scanning includes `.v`, `.sv`, `.vh` and `.svh`, excluding `node_modules`, `.git`, `out`, `dist` and `build`. A file outside a workspace is indexed on its own.

Saving through the global settings menu applies changes immediately. Reload the window after editing the configuration file directly. Fields with the same names in project settings do not override these global settings.

The JSON above shows only the relevant fields; preserve other settings when editing your file. The old VS Code settings `zhdl.indexing.scope` and `zhdl.indexing.liveParsing` are no longer read. You can remove them from `settings.json` and configure the options in ZHDL's global settings menu.

On a blank line inside a module body, type a module name and select its completion to generate an instance with named parameters and ports. Each port has an aligned direction and width comment, such as `// input [WIDTH-1:0]`. Single-bit ports show `[0:0]`; custom types with an undetermined width show `width unknown`. Use **Tab** to edit the instance name, followed by parameter values and port connections.

Type `.` in an existing instance's connection list to complete unconnected ports, or in its `#(...)` parameter override list to complete parameters. Type `u_instance.` to complete the instance's module ports. Inside a `.port(...)` expression, completion uses signals from the current module.

Ctags symbols and other files' module interfaces update after saves or disk changes. The current file's module interface and completion context are read from the editor buffer. Indexing parses syntax without HDL preprocessing or elaboration, so macro-generated interfaces may be incomplete. Initial completion waits for project indexing; later requests reuse the cache.

### Incremental completion for unsaved changes (experimental)

Select **Enable live parsing (experimental)** on the global settings **General** page (`live_parsing`). It updates unsaved Verilog and SystemVerilog signal completion and Outline entries, and is disabled by default.

Open files share an on-demand background Worker that retains each file's previous syntax tree. Common module-body declaration edits update the affected declarations and return symbol deltas. Edits are coalesced for 30–100 ms, with a maximum wait of 150 ms; completion requests trigger pending updates earlier. Each file has at most one parsing request in flight, with subsequent edits merged into the latest version. Closing a file releases its tree; closing all tracked files terminates the Worker.

Module headers, parameters, procedural blocks and syntax errors currently trigger full symbol extraction. These complex edits have higher latency and memory costs on large files. This experiment has not replaced the project's ctags index. Ctags-only symbol kinds still come from saved-file caches, and macros and includes are not expanded semantically. Disabling the option restores saved-file symbol completion.

Local synthetic benchmarks used Linux, a Xeon E5-2680 v4, Node.js 25.8.1 and `web-tree-sitter` 0.20.8, with four modules per file. These are median request round-trip times for common declaration edits, including Worker parsing, symbol delta transfer and client cache updates. They exclude the coalescing delay, VS Code rendering and initial project indexing:

| Lines | Symbols | Common declaration edit |
|---|---|---|
| 220 | 120 | About 2 ms |
| 2,020 | 1,020 | About 3 ms |
| 20,020 | 10,020 | About 23 ms |

In a separate stress test, initial analysis of the 20,000-line file took about 1.2 seconds including Worker startup. Header changes or incomplete statements took about 0.55–0.61 seconds, mainly due to full module metadata and symbol extraction; incremental syntax parsing itself took about 20–23 ms.

During continuous editing, total test-process RSS was about 400–436 MiB, including the main thread, Worker and WASM memory. This is not the Worker's exclusive memory usage and does not establish the absence of long-term leaks. Live parsing therefore remains disabled by default, pending verification in actual extension hosts.

### Lint diagnostic updates

Once the selected linter is configured and enabled, edits trigger diagnostic updates without requiring a save. Edit events are currently coalesced for about 250 ms; opening and saving files also trigger checks. External lint tools generally process the complete content, so their costs are separate from Tree-sitter incremental completion. Tool paths, enablement and execution time affect when diagnostics appear.

## Bundled tools

- Verible LSP: `v0.0-4219-g3275ab72`, with Linux x86_64 and Windows x64 binaries.
- Universal Ctags: `6.2.0 (ab95af1)`, from the official 2026-09-16 nightly build, with Linux x86_64, macOS Intel and Windows x86 binaries.
- Versions, download sources and SHA-256 checksums are recorded in `server/binaries.json`. Run `python3 server/update_binaries.py` to reinstall the pinned versions. Update the manifest when changing versions.

## Configuration file locations

Global settings and project data are stored in the home directory of the user running the extension:

| File | Purpose |
|---|---|
| `~/.zhdl_config.json` | Global settings, including tool paths, linters, formatting and indexing |
| `~/.zhdl_prj.json` | Project list and project data |

On Linux and macOS, `~` is the current user's home directory. On Windows it corresponds to `%USERPROFILE%`, for example `C:\Users\yourname\.zhdl_config.json`. With Remote SSH, WSL or containers, these files are in the home directory of the remote or container user running the extension.

ZHDL uses these files independently and no longer automatically reads or writes TerosHDL's `~/.teroshdl2_config.json` and `~/.teroshdl2_prj.json`. When switching to independent settings, configure tool paths again or use **Load Settings** in ZHDL's global settings menu to import the old `.teroshdl2_config.json`. Imported settings are saved to ZHDL's own configuration file. You can also use **Export Settings** to create a backup.

To migrate the old project list, close the relevant extension hosts, back up any existing `.zhdl_prj.json`, and copy `.teroshdl2_prj.json` to `.zhdl_prj.json`. The project format remains compatible; the original file can remain in place. The two copies are maintained independently after migration.

The default tool build directory is `~/.zhdl/build`. Temporary files in the home directory use the `.zhdl_` prefix, and workspace caches use the extension's own storage directory. The installation-state file, `user.zhdl.config.json`, is stored in the extension installation directory and records installation and version state rather than global tool settings.

The Output channels are **ZHDL: Global**, **ZHDL: Tool Manager** and **ZHDL: Debug**. Commands and project views use independent `zhdl` identifiers. Update custom keybindings referencing `teroshdl.*` commands to the corresponding `zhdl.*` names.

## Local development

Requirements: Node.js 22, npm, Python 3 and Git. In the repository root, run:

```bash
npm install
npm run compile
```

In VS Code's **Run and Debug** panel, select **Run ZHDL** and press **F5** to launch the extension development host. This starts a compilation watcher. After source changes compile, run **Developer: Reload Window** in the development host.

Checks and tests:

```bash
npx tsc -p ./ --noEmit
npm test
npm run lint
```

Run the language service and parser regression tests separately with:

```bash
npm run compile
node node_modules/jest/bin/jest.js tests/teroshdl tests/parser --runInBand --coverage=false --reporters=default
```

Worker tests use compiled files under `out`, so compile before testing source changes. `npm run compile` already copies resources and builds both Webview bundles; you do not need to run those steps individually.

To check keyword completion, open and save a `.v` or `.sv` file and confirm its language mode is Verilog or SystemVerilog. Type prefixes such as `alw` or `pos` and press `Ctrl+Space`. SystemVerilog files should also offer `always_ff`, `always_comb` and `logic`.

## TODO

- [ ] Cache interfaces and symbols per module and recover incomplete declarations locally to reduce full-file extraction after header, parameter and syntax-error edits.
- [ ] Extend incremental updates to procedural blocks, functions and tasks, and improve SystemVerilog class, interface and package scope handling.
- [ ] Use edit-event change ranges directly to reduce full-text comparisons, symbol array copies and position shifts; evaluate compact storage and lazy position calculation.
- [ ] Unify saved-file, editor-buffer and project parsing caches to avoid duplicate work and move expensive initial project analysis off the extension's main thread.
- [ ] Use unsaved symbols for hover and go to definition, sharing versions and scopes across completion, Outline, hover and navigation; evaluate project-level macro and include handling.
- [ ] Add memory budgets, cache eviction and task priorities for large and multiple files. Test prolonged editing, repeated opening and closing, rapid edits and actual UI response before considering enabling live parsing by default.
- [ ] Rebuild and validate compatible HDL WASM grammars before upgrading `web-tree-sitter`, and migrate its APIs and imports. The existing WASM binaries could not be used directly with the tested newer version.
- [ ] Bound per-file lint concurrency, discard stale diagnostics, and improve cancellation, timeouts, exception handling and temporary-file cleanup; evaluate configurable refresh delays.
- [ ] Verify Axios `navigator` compatibility in the extension host and evaluate lazy loading for optional tools such as Sandpiper.
- [ ] Continue investigating development window exits with client logs, actual telemetry call stacks, isolated startup, debugger network inspection disabled, and long-term memory and connection monitoring.
- [ ] Add a migration wizard for old settings and project lists, including confirmation, backups and error reporting.
- [ ] Improve test isolation and resource cleanup. Configuration, project management and parsing regressions pass in separate groups, but combined runs have encountered parsing timeouts, and configuration tests retain open handles after finishing.

## Documentation and feedback

- [Repository documentation](docs/)
- [Report an issue](https://github.com/narutozxp/vscode-terosHDL/issues)
- [Upstream TerosHDL documentation](https://terostechnology.github.io/terosHDLdoc/) for shared features.

## Acknowledgments

Thanks to [Teros Technology](https://github.com/TerosTechnology) and the [TerosHDL maintainers and contributors](https://github.com/TerosTechnology/vscode-terosHDL). This project's foundational features and architecture come from their open-source work.

## License

This project retains the upstream [GNU GPL v3 license](LICENSE). Original author copyright notices are preserved.
