// Run against an extracted VSIX, not the development checkout:
// node tests/packaging/offline_smoke.cjs /absolute/path/to/extension
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { createRequire } = require('module');
const { pathToFileURL } = require('url');

// This file is also preloaded in parser workers, so they inherit the same guard.
const denied = () => { throw new Error('Network access denied by offline package check'); };
for (const [name, keys] of [
    ['http', ['request', 'get']], ['https', ['request', 'get']],
    ['net', ['connect', 'createConnection']], ['tls', ['connect']], ['dgram', ['createSocket']]
]) {
    const module = require(name);
    for (const key of keys) { module[key] = denied; }
}
globalThis.fetch = denied;

async function check(root) {
    process.chdir(root);
    const req = createRequire(path.join(root, 'package.json'));
    for (const name of Object.keys(req('./package.json').dependencies)) { req.resolve(name); }
    assert(!fs.existsSync(path.join(root, 'node_modules/typescript')));
    assert(!fs.existsSync(path.join(root, 'node_modules/jest')));

    const SQL = await req('sql.js')();
    const db = new SQL.Database();
    try {
        db.run('CREATE TABLE t(n); INSERT INTO t VALUES(42)');
        assert.equal(db.exec('SELECT n FROM t')[0].values[0][0], 42);
    } finally { db.close(); }
    console.log('PASS SQLite WASM');

    const yaml = req('js-yaml');
    const configuration = { name: 'offline', sources: ['top.sv'] };
    assert.deepEqual(yaml.load(yaml.dump(configuration)), configuration);
    console.log('PASS YAML configuration');

    const { BufferLanguageService } = req('./out/teroshdl/features/language_provider/index/bufferService.js');
    const service = new BufferLanguageService(console.warn);
    try {
        const document = {
            uri: { scheme: 'file', fsPath: path.join(root, 'offline.sv') },
            languageId: 'systemverilog', version: 1,
            getText: () => 'module top(input clk); reg [7:0] count; endmodule'
        };
        const snapshot = await service.get(document);
        assert(snapshot.symbols.some(symbol => symbol.name === 'count'));
    } finally { service.dispose(); }
    console.log('PASS live parser Worker/WASM');

    const Viz = req('./resources/viz/viz.js');
    const render = req('./resources/viz/full.render.js');
    const svg = await new Viz({ Module: render.Module, render: render.render }).renderString('digraph {a -> b}');
    assert(svg.includes('<svg'));
    console.log('PASS Graphviz rendering');

    const python = await req('pyodide').loadPyodide();
    assert.equal(python.runPython('sum(range(10))'), 45);
    console.log('PASS Pyodide runtime/stdlib');

    const { runYosys } = await import(pathToFileURL(req.resolve('@yowasp/yosys')).href);
    const result = await runYosys([
        '-Q', '-T', '-p', 'read_verilog /top.v; hierarchy -top top; proc; write_json output.json'
    ], { 'top.v': 'module top(input a, output b); assign b=a; endmodule' }, { decodeASCII: true });
    assert(result['output.json']);
    console.log('PASS Yosys WASM synthesis');

    // Execute the packaged HTML builders with URI-only VS Code objects. Validate
    // every script/style URL without depending on a browser or the checkout.
    for (const [file, name] of [
        ['./out/teroshdl/features/dependency.js', 'Dependency_manager'],
        ['./out/teroshdl/features/state_machine.js', 'State_machine_manager']
    ]) {
        const exports = {};
        const vscode = { Uri: { joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) }) } };
        const customRequire = id => id === 'vscode' ? vscode : id === './base_webview' ?
            { Base_webview: class {} } : ['fs', 'path', 'nunjucks'].includes(id) ? req(id) : {};
        new Function('exports', 'require', fs.readFileSync(path.join(root, file), 'utf8'))(exports, customRequire);
        const manager = Object.create(exports[name].prototype);
        manager.context = { extensionPath: root, extensionUri: { fsPath: root } };
        const html = manager.get_webview_content({ asWebviewUri: uri => uri.fsPath, cspSource: 'offline' });
        const resources = [...html.matchAll(/(?:src|href)="([^"]*)"/g)].map(match => match[1]);
        assert(resources.some(resource => resource.endsWith('/resources/viz/full.render.js')));
        for (const resource of resources) { assert(resource && fs.existsSync(resource), `${file}: ${resource}`); }
        console.log('PASS Webview resource bindings:', name);
    }
}

if (require.main === module) {
    if (!process.argv[2]) { throw new Error('Usage: node offline_smoke.cjs /path/to/extracted/extension'); }
    const root = path.resolve(process.argv[2]);
    process.execArgv.push('--require', __filename);
    check(root).catch(error => { console.error(error); process.exitCode = 1; });
}
