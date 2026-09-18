// Compile first: npx tsc -p ./
// Run: node tests/teroshdl/live_parsing.bench.js [--baseline-outline] [--baseline-visibility] [--service-root DIR]
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { performance: timer } = require('perf_hooks');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const serviceFlag = process.argv.indexOf('--service-root');
const serviceRoot = serviceFlag < 0 ? root : path.resolve(process.argv[serviceFlag + 1]);
const { BufferLanguageService } = require(path.join(serviceRoot, 'out/teroshdl/features/language_provider/index/bufferService'));
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

function outlineBenchmark(source, label) {
    // Use synthetic VS Code objects to isolate hierarchy building from editor rendering.
    const exports = {};
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    new Function('exports', 'require', code)(exports, id => id === 'vscode' ?
        { SymbolKind: { Module: 1, Variable: 2 } } : id === '../ctags' ? { CtagsManager: {} } : {});
    const provider = new exports.default({}, {});
    function symbol(name, type, start, end = start) {
        return { name, type,
            startPosition: { line: start, isBefore: other => start < other.line, isAfter: other => start > other.line },
            endPosition: { line: end },
            getDocumentSymbol: () => ({ name, kind: type === 'module' ? 1 : 2, children: [],
                range: { start, end, contains: other => start <= other.start && other.end <= end } }) };
    }
    const symbols = [symbol('top', 'module', 0, 10001),
        ...Array.from({ length: 10000 }, (_, index) => symbol(`signal_${index}`, 'register', index + 1))];
    const times = [];
    for (let index = 0; index < 5; index++) {
        const start = timer.now();
        const result = provider.buildDocumentSymbolList(symbols);
        times.push(timer.now() - start);
        if (result[0].children.length !== 10000) { throw new Error('Incorrect outline'); }
    }
    console.log(JSON.stringify({ label, symbols: 10000, medianMs: median(times) }));
}

function visibilityBenchmark(source, label) {
    const exports = {};
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    new Function('exports', code)(exports);
    const scopes = Array.from({ length: 1000 }, (_, index) => ({ name: `m_${index}`, type: 'module',
        start: index * 10, end: index * 10 + 9, startLine: index * 10, endLine: index * 10 + 9 }));
    for (const owned of [true, false]) {
        const symbols = Array.from({ length: 10000 }, (_, index) => ({ name: `s_${index}`, type: 'register',
            parentScope: owned ? `m_${index % 1000}.fn` : '', startPosition: { line: index % 1000 * 10 } }));
        const times = [];
        for (let index = 0; index < 10; index++) {
            const start = timer.now();
            const result = exports.getVisibleCompletionSymbols(symbols, scopes, 5000);
            times.push(timer.now() - start);
            if (result.length !== 10) { throw new Error('Incorrect visibility'); }
        }
        console.log(JSON.stringify({ label, owned, scopes: scopes.length, symbols: symbols.length, medianMs: median(times) }));
    }
}

async function main() {
    const file = 'src/teroshdl/features/language_provider/ctags/providers/DocumentSymbolProvider.ts';
    if (process.argv.includes('--baseline-outline')) {
        outlineBenchmark(execFileSync('git', ['show', `HEAD:${file}`], { cwd: root, encoding: 'utf8' }), 'outline HEAD');
    }
    outlineBenchmark(fs.readFileSync(path.join(root, file), 'utf8'), 'outline working tree');
    const visibility = 'src/teroshdl/features/language_provider/ctags/providers/completionScopes.ts';
    if (process.argv.includes('--baseline-visibility')) {
        visibilityBenchmark(execFileSync('git', ['show', `HEAD:${visibility}`], { cwd: root, encoding: 'utf8' }), 'visibility HEAD');
    }
    visibilityBenchmark(fs.readFileSync(path.join(root, visibility), 'utf8'), 'visibility working tree');
    const service = new BufferLanguageService(console.warn);
    try {
        let reads = 0;
        const document = { uri: { fsPath: path.join(root, 'zhdl-live-benchmark.sv') }, languageId: 'systemverilog', version: 1,
            source: 'module top #(parameter WIDTH=8)(input clk);\n' + Array.from({ length: 10000 }, (_, index) => `reg [7:0] signal_${index};`).join('\n') +
                '\ngenerate if (1) begin : g wire generated; end endgenerate\nalways @(posedge clk) begin signal_500 <= 1; end\nendmodule',
            getText() { reads++; return this.source; } };
        const start = timer.now();
        const initial = await service.get(document);
        console.log(JSON.stringify({ label: 'initial', workerMs: initial.timing.totalMs, roundTripMs: timer.now() - start }));
        const originalPost = service.worker.postMessage.bind(service.worker);
        let sentChars = 0;
        service.worker.postMessage = message => {
            sentChars += message.source?.length ?? message.edits?.reduce((total, edit) => total + edit.text.length, 0) ?? 0;
            return originalPost(message);
        };
        function position(source, offset) {
            const lines = source.slice(0, offset).split('\n');
            return { line: lines.length - 1, character: lines[lines.length - 1].length };
        }
        function patch(start, length, text) {
            const change = { rangeOffset: start, rangeLength: length, text,
                range: { start: position(document.source, start), end: position(document.source, start + length) } };
            document.source = document.source.slice(0, start) + text + document.source.slice(start + length);
            document.version++;
            return [change];
        }
        for (const scenario of ['same text', 'declaration', 'procedural body', 'module header', 'parameter', 'generate']) {
            const workerTimes = [], roundTripTimes = [];
            reads = 0; sentChars = 0;
            let snapshot;
            for (let index = 0; index < 10; index++) {
                let changes;
                if (scenario === 'same text') { document.version++; changes = []; }
                else if (scenario === 'declaration') {
                    const before = `[${index % 2 ? 15 : 7}:0] signal_500`;
                    changes = patch(document.source.indexOf(before), index % 2 ? 6 : 5, `[${index % 2 ? 7 : 15}:0]`);
                } else if (scenario === 'procedural body') {
                    changes = patch(document.source.indexOf(`signal_500 <= ${index % 2 ? 2 : 1}`) + 'signal_500 <= '.length, 1, `${index % 2 ? 1 : 2}`);
                } else if (scenario === 'module header') {
                    const before = index % 2 ? 'inout clk' : 'input clk';
                    changes = patch(document.source.indexOf(before), before.length, index % 2 ? 'input clk' : 'inout clk');
                } else if (scenario === 'parameter') {
                    const before = index % 2 ? 'WIDTH=16' : 'WIDTH=8';
                    changes = patch(document.source.indexOf(before), before.length, index % 2 ? 'WIDTH=8' : 'WIDTH=16');
                } else {
                    changes = patch(document.source.indexOf(`if (${index % 2 ? 0 : 1})`) + 4, 1, `${index % 2 ? 1 : 0}`);
                }
                const start = timer.now();
                service.changed(document, changes);
                snapshot = await service.get(document);
                roundTripTimes.push(timer.now() - start);
                workerTimes.push(snapshot.timing.totalMs);
            }
            console.log(JSON.stringify({ label: scenario, declarations: 10000, sourceChars: document.source.length,
                workerMedianMs: median(workerTimes), roundTripMedianMs: median(roundTripTimes),
                fullTextReads: reads, sentChars, local: !!snapshot.timing.local, extraction: snapshot.timing.extraction, inputMode: snapshot.timing.inputMode }));
        }
        const shared = { ...document, uri: { fsPath: path.join(root, 'zhdl-live-benchmark-shared.sv') }, version: 1,
            source: `module shared; reg [7:0] ${Array.from({ length: 1000 }, (_, index) => `s_${index}`).join(',')}; endmodule` };
        const sharedStart = timer.now();
        const sharedSnapshot = await service.get(shared);
        if (sharedSnapshot.symbols.filter(symbol => symbol.type === 'register').length !== 1000) { throw new Error('Incorrect shared declaration'); }
        console.log(JSON.stringify({ label: '1000 names in one declaration', workerMs: sharedSnapshot.timing.totalMs, roundTripMs: timer.now() - sharedStart }));
        const multiple = { ...document, uri: { fsPath: path.join(root, 'zhdl-live-benchmark-modules.sv') }, version: 1,
            source: Array.from({ length: 100 }, (_, module) => `module part_${module};\nparameter BODY=1;\n` +
                Array.from({ length: 100 }, (_, index) => `reg [7:0] s_${index};`).join('\n') + '\nendmodule').join('\n') };
        await service.get(multiple);
        const workerTimes = [], roundTripTimes = [];
        reads = 0; sentChars = 0;
        let snapshot;
        for (let index = 0; index < 10; index++) {
            const offset = multiple.source.indexOf('parameter BODY=', multiple.source.indexOf('module part_50;')) + 'parameter BODY='.length;
            const change = { rangeOffset: offset, rangeLength: 1, text: `${index % 2 ? 1 : 2}`,
                range: { start: position(multiple.source, offset), end: position(multiple.source, offset + 1) } };
            multiple.source = multiple.source.slice(0, offset) + change.text + multiple.source.slice(offset + 1);
            multiple.version++;
            const start = timer.now();
            service.changed(multiple, [change]); snapshot = await service.get(multiple);
            roundTripTimes.push(timer.now() - start); workerTimes.push(snapshot.timing.totalMs);
        }
        console.log(JSON.stringify({ label: 'body parameter in 100 modules', sourceChars: multiple.source.length,
            workerMedianMs: median(workerTimes), roundTripMedianMs: median(roundTripTimes),
            fullTextReads: reads, sentChars, extraction: snapshot.timing.extraction }));
    } finally { service.dispose(); }

}
main().catch(error => { console.error(error); process.exitCode = 1; });
