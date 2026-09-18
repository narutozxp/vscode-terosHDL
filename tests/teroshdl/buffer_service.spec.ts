import * as path from 'path';
import { getCompletionScopes } from '../../src/teroshdl/features/language_provider/ctags/providers/completionScopes';

// Exercise the actual compiled worker and WASM, not a mocked parser.
const { BufferLanguageService } = require('../../out/teroshdl/features/language_provider/index/bufferService');

describe('Live buffer parsing', () => {
    let service: any;
    beforeEach(() => { service = new BufferLanguageService(() => {}); });
    afterEach(() => service.dispose());
    function doc(source: string) {
        return { uri: { fsPath: path.join('/tmp', 'zhdl-live-test.sv') }, languageId: 'systemverilog',
            version: 1, getText() { return this.source; }, source };
    }
    function edit(document: any, source: string) { document.source = source; document.version++; }
    it('adds, changes and deletes unsaved declarations without stale widths or duplicates', async () => {
        const document = doc('module top(input clk);\nreg [7:0] count;\nwire value;\nendmodule');
        await service.get(document);
        edit(document, document.source.replace('wire value;', 'wire value;\nreg [15:0] added;'));
        let snapshot = await service.get(document);
        expect(snapshot.symbols.find((symbol: any) => symbol.name === 'added').outlineDetail).toBe('reg [15:0]');
        edit(document, document.source.replace('[15:0]', '[31:0]'));
        snapshot = await service.get(document);
        expect(snapshot.symbols.filter((symbol: any) => symbol.name === 'added')).toHaveLength(1);
        expect(snapshot.symbols.find((symbol: any) => symbol.name === 'added').outlineDetail).toBe('reg [31:0]');
        edit(document, document.source.replace('reg [31:0] added;\n', ''));
        snapshot = await service.get(document);
        expect(snapshot.symbols.some((symbol: any) => symbol.name === 'added')).toBe(false);
    });
    it('keeps signals while a following body statement is incomplete', async () => {
        const document = doc('module top(input clk);\nreg [7:0] count;\nendmodule');
        await service.get(document);
        edit(document, document.source.replace('endmodule', 'cou\nendmodule'));
        const snapshot = await service.get(document);
        expect(snapshot.symbols.find((symbol: any) => symbol.name === 'count').outlineDetail).toBe('reg [7:0]');
        expect(snapshot.modules.map((module: any) => module.name)).toEqual(['top']);
    });
    it('does not index keywords and assignments misclassified by grammar error recovery', async () => {
        const document = doc(`module top(input clk, input rst, input sel);
reg en0;
reg en1;
assign
always @(negedge clk, negedge rst) begin
    if (!rst) en0 <= 0;
    else begin en0 <= sel & (~en1); end
end
assign en
endmodule`);
        const snapshot = await service.get(document);
        expect(snapshot.symbols.filter((symbol: any) => symbol.type === 'register').map((symbol: any) => symbol.name).sort()).toEqual(['en0', 'en1']);
        expect(snapshot.symbols.some((symbol: any) => ['always', 'if', 'else', 'begin', 'end'].includes(symbol.name))).toBe(false);
        expect(snapshot.symbols.filter((symbol: any) => symbol.type === 'instance')).toHaveLength(0);
    });
    it('updates port directions and preserves module ownership after earlier lines move', async () => {
        const document = doc('module first(input wire [7:0] data);\nreg a;\nendmodule\nmodule second;\nwire b;\nendmodule');
        await service.get(document);
        edit(document, document.source.replace('reg a;', 'reg a;\nreg c;'));
        let snapshot = await service.get(document);
        expect(snapshot.symbols.find((symbol: any) => symbol.name === 'b')).toMatchObject({ parentScope: 'second', line: 5 });
        edit(document, document.source.replace('input wire [7:0]', 'output reg [15:0]'));
        snapshot = await service.get(document);
        expect(snapshot.symbols.find((symbol: any) => symbol.name === 'data').outlineDetail).toBe('output reg [15:0]');
    });
    it('coalesces edits arriving while parsing and returns the latest document version', async () => {
        const document = doc('module top;\nreg first;\nendmodule');
        const initial = service.get(document);
        edit(document, 'module top;\nwire latest;\nendmodule');
        service.changed(document);
        const snapshot = await initial;
        expect(snapshot.version).toBe(document.version);
        expect(snapshot.symbols.some((symbol: any) => symbol.name === 'latest')).toBe(true);
        expect(snapshot.symbols.some((symbol: any) => symbol.name === 'first')).toBe(false);
        expect(await service.get(document)).toBe(snapshot);
    });
    it('releases closed files and recreates the worker on reopening', async () => {
        const document = doc('module top; reg a; endmodule');
        await service.get(document); service.close(document);
        edit(document, 'module fresh; wire b; endmodule');
        const snapshot = await service.get(document);
        expect(snapshot.modules.map((module: any) => module.name)).toEqual(['fresh']);
        expect(snapshot.timing.retainedFiles).toBe(1);
    });
    it('matches a fresh parse across CRLF, Unicode, shared declarations, instances and module renames', async () => {
        const document = doc('module first(input clk);\r\n// 中文 😀\r\nreg [7:0] a,b;\r\nchild u();\r\nendmodule\r\nmodule second;\r\nwire c;\r\nendmodule');
        const sources = [document.source,
            document.source.replace('a,b', 'a,added,b'),
            document.source.replace('[7:0]', '[15:0]'),
            document.source.replace('child u()', 'other v()'),
            document.source.replace('module first', 'module renamed'),
            document.source.replace('reg [7:0] a,b;\r\n', ''),
            document.source.replace('wire c;', 'wire [3:0] c;\r\nreg d;')];
        const normalize = (snapshot: any) => snapshot.symbols.map((symbol: any) =>
            ({ ...symbol })).sort((a: any, b: any) => a.offset - b.offset || a.name.localeCompare(b.name));
        for (const source of sources) {
            edit(document, source);
            const incremental = await service.get(document);
            const fresh = doc(source); fresh.uri.fsPath = '/tmp/zhdl-live-oracle.sv';
            const reference = await service.get(fresh);
            expect(normalize(incremental)).toEqual(normalize(reference));
            service.close(fresh);
        }
    });
    it('reuses parsed records when only the document version changes', async () => {
        const document = doc('module top(input clk); reg [7:0] count; endmodule');
        const initial = await service.get(document);
        document.version++;
        const snapshot = await service.get(document);
        expect(snapshot.version).toBe(document.version);
        expect(snapshot.timing.parseMs).toBe(0);
        expect(snapshot.symbols).toBe(initial.symbols);
        expect(snapshot.modules).toBe(initial.modules);
    });
    it('starts a new debounce window after an idle period and bounds continuous edits', async () => {
        const document = doc('module top; reg a; endmodule');
        await service.get(document);
        jest.useFakeTimers();
        try {
            jest.advanceTimersByTime(1000);
            const get = jest.spyOn(service, 'get').mockResolvedValue({});
            edit(document, document.source.replace('reg a', 'reg b'));
            service.changed(document);
            jest.advanceTimersByTime(0);
            expect(get).not.toHaveBeenCalled();
            // Continuous input postpones the adaptive delay, but never beyond 150 ms.
            for (let index = 0; index < 14; index++) {
                jest.advanceTimersByTime(10);
                service.changed(document);
            }
            jest.advanceTimersByTime(10);
            expect(get).toHaveBeenCalledTimes(1);
            get.mockRestore();
        } finally { jest.useRealTimers(); }
    });
    it('rejects a closed file immediately while keeping another file available', async () => {
        const document = doc('module top; reg a; endmodule');
        const other = doc('module other; wire b; endmodule');
        other.uri.fsPath = '/tmp/zhdl-live-other.sv';
        const pending = service.get(document);
        const rejected = expect(pending).rejects.toThrow('Document closed');
        const remaining = service.get(other);
        service.close(document);
        expect(service.pending.size).toBe(1);
        await rejected;
        const snapshot = await remaining;
        expect(snapshot.modules.map((module: any) => module.name)).toEqual(['other']);
        expect(snapshot.timing.retainedFiles).toBe(1);
        // A subsequent request is queued after the close message, so worker state is released.
        other.version++;
        expect((await service.get(other)).timing.retainedFiles).toBe(1);
    });

    function position(source: string, offset: number) {
        const lines = source.slice(0, offset).split('\n');
        return { line: lines.length - 1, character: lines[lines.length - 1].length };
    }
    function patch(document: any, start: number, length: number, text: string) {
        const changes = [{ rangeOffset: start, rangeLength: length, text,
            range: { start: position(document.source, start), end: position(document.source, start + length) } }];
        edit(document, document.source.slice(0, start) + text + document.source.slice(start + length));
        service.changed(document, changes);
    }
    const normalize = (snapshot: any) => ({
        symbols: snapshot.symbols.map((symbol: any) => ({ ...symbol }))
            .sort((a: any, b: any) => a.offset - b.offset || a.name.localeCompare(b.name)),
        modules: snapshot.modules.map(({ filePath, ...model }: any) => model), scopes: snapshot.scopes
    });
    async function expectFresh(document: any, snapshot: any) {
        expect(snapshot.scopes).toEqual(getCompletionScopes(document.source));
        const fresh = doc(document.source); fresh.uri.fsPath = '/tmp/zhdl-live-edit-oracle.sv';
        try { expect(normalize(snapshot)).toEqual(normalize(await service.get(fresh))); }
        finally { service.close(fresh); }
    }
    const editingMatrixSource = `module top #(parameter WIDTH=8)(input clk, output [WIDTH-1:0] data);
reg [7:0] a,b;
wire w;
localparam LIMIT=3;
parameter BODY=2;
always @(posedge clk) begin a <= b + 1; end
generate if (1) begin : g wire generated; end endgenerate
child #(.P(WIDTH)) u(.clk(clk));
endmodule
module other; wire untouched; endmodule`;
    it.each([
        ['declaration width', '[7:0] a,b', '[31:0] a,b', 'items'],
        ['declaration kind', 'reg [7:0] a,b;', 'logic signed [7:0] a,b;', 'items'],
        ['shared declaration name removal', 'a,b;', 'a;', 'items'],
        ['declaration initializer', 'reg [7:0] a,b;', 'reg [7:0] a=1,b=2;', 'items'],
        ['escaped identifier', 'wire w;', 'wire \\escaped.name ;', undefined],
        ['enum declaration', 'reg [7:0] a,b;', 'typedef enum logic [1:0] {IDLE, BUSY} state_t; state_t a;', undefined],
        ['packed struct declaration', 'reg [7:0] a,b;', 'typedef struct packed {logic [7:0] field;} packet_t; packet_t a;', undefined],
        ['string containing design keywords', 'reg [7:0] a,b;', 'reg [7:0] a="endmodule; module fake;",b;', undefined],
        ['unpacked dimension', 'reg [7:0] a,b;', 'reg [7:0] a [0:3],b;', 'items'],
        ['net insertion', 'wire w;', 'wire w;\ntri new_net;', 'items'],
        ['declaration deletion', 'wire w;', '', undefined],
        ['local parameter value', 'LIMIT=3', 'LIMIT=12', 'items'],
        ['body parameter default', 'BODY=2', 'BODY=4', 'module'],
        ['body parameter addition', 'parameter BODY=2;', 'parameter BODY=2, EXTRA=5;', 'module'],
        ['procedural expression', 'b + 1', 'b + 2', 'expression'],
        ['always_ff keyword', 'always @', 'always_ff @', undefined],
        ['procedural local declaration', 'begin a <=', 'begin reg tmp; a <=', 'items'],
        ['continuous assignment insertion', 'wire w;', 'wire w;\nassign w = a[0];', 'items'],
        ['instance rename', 'u(.clk(clk))', 'renamed_instance(.clk(clk))', 'items'],
        ['instance type', 'child #', 'other_child #', 'items'],
        ['instance parameter expression', '.P(WIDTH)', '.P(WIDTH+1)', 'items'],
        ['generate condition', 'if (1)', 'if (0)', 'items'],
        ['generate block name', 'begin : g', 'begin : renamed_g', 'items'],
        ['generate local declaration', 'wire generated;', 'logic [3:0] generated, added;', 'items'],
        ['generate loop', 'if (1) begin : g', 'for (genvar i=0;i<2;i=i+1) begin : g', 'items'],
        ['generate body parameter', 'wire generated;', 'parameter GENERATED_P=2; wire generated;', 'module'],
        ['port direction', 'input clk', 'inout clk', 'header'],
        ['port add with inheritance', 'output [WIDTH-1:0] data', 'output [WIDTH-1:0] data, extra', 'header'],
        ['port deletion', ', output [WIDTH-1:0] data', '', 'header'],
        ['port refers to body parameter', 'output [WIDTH-1:0] data', 'output [BODY-1:0] data', 'header'],
        ['header parameter default', 'WIDTH=8', 'WIDTH=16', 'header'],
        ['header parameter rename', 'WIDTH=8', 'RENAMED_WIDTH=8', 'module'],
        ['header parameter addition', 'parameter WIDTH=8', 'parameter WIDTH=8, parameter EXTRA=2', 'module'],
        ['inherited header parameter addition', 'parameter WIDTH=8', 'parameter WIDTH=8, EXTRA=2', 'full'],
        ['header parameter removal', '#(parameter WIDTH=8)', '', 'module'],
        ['header type parameter', 'parameter WIDTH=8', 'parameter type TYPE=logic', undefined],
        ['module rename', 'module top', 'module renamed_top', 'header'],
        ['module attribute', 'module top', '(* keep="true" *) module top', 'header'],
        ['comment between declarations', 'wire w;', '// 中文 😀 "module fake;"\nwire w;', 'items'],
        ['comment masks declaration', 'wire w;', '/* wire w; */', 'items'],
        ['whitespace with newline', 'wire w;', '\n\t wire w;\n', 'items'],
        ['temporary declaration error', 'wire w;', 'wire [ w;', 'full'],
        ['design unit insertion', 'module other;', 'module added; endmodule\nmodule other;', 'full'],
        ['design unit deletion', 'module other; wire untouched; endmodule', '', 'full'],
        ['endmodule label', 'module other; wire untouched; endmodule', 'module other; wire untouched; endmodule : other', undefined],
        ['macro directive', 'wire w;', '`define SIZE 8\nwire w;', undefined],
        ['macro expression', 'b + 1', 'b + `SIZE', undefined],
        ['include directive', 'wire w;', '`include "defs.svh"\nwire w;', undefined],
        ['conditional directive', 'wire w;', '`ifdef FEATURE\nwire w;\n`endif', undefined],
        ['package insertion', 'module top #', 'package definitions; parameter P=1; endpackage\nmodule top #', 'full'],
        ['interface insertion', 'module top #', 'interface bus; logic data; endinterface\nmodule top #', 'full'],
        ['program insertion', 'module top #', 'program test_program; int count; endprogram\nmodule top #', 'full']
    ])('matches fresh extraction for %s edits', async (_label, before, after, extraction) => {
        const document = doc(editingMatrixSource);
        const initial = await service.get(document);
        const getText = jest.spyOn(document, 'getText').mockImplementation(() => { throw new Error('Unexpected full read'); });
        const start = document.source.indexOf(before);
        patch(document, start, before.length, after);
        const snapshot = await service.get(document);
        expect(snapshot.timing.inputMode).toBe('edits');
        if (extraction) { expect(snapshot.timing.extraction).toBe(extraction); }
        await expectFresh(document, snapshot);
        // Undo also exercises old-error/new-valid trees and removal of newly created records.
        patch(document, start, after.length, before);
        await expectFresh(document, await service.get(document));
        expect(getText).not.toHaveBeenCalled();
        if (before.length === after.length && !after.includes('\n') && extraction !== 'full') {
            expect(snapshot.symbols.find((symbol: any) => symbol.name === 'untouched'))
                .toBe(initial.symbols.find((symbol: any) => symbol.name === 'untouched'));
        }
    });
    it('transports edits without reading the full document and matches a fresh parse', async () => {
        const document = doc('module top(input clk);\r\n// 中文 😀\r\nreg [7:0] a,b;\r\nalways @(posedge clk) begin a <= b; end\r\nendmodule\r\nmodule other; wire c; endmodule');
        await service.get(document);
        const getText = jest.spyOn(document, 'getText').mockImplementation(() => { throw new Error('Unexpected full read'); });
        const operations = [
            () => patch(document, document.source.indexOf('[7:0]'), 5, '[15:0]'),
            () => patch(document, document.source.indexOf('a,b'), 3, 'a,added,b'),
            () => patch(document, document.source.indexOf('a <= b'), 6, 'a <= b + 1'),
            () => patch(document, document.source.indexOf('reg [15:0]'), 0, '// comment\r\n'),
            () => patch(document, document.source.indexOf('wire c;'), 7, 'wire [3:0] c;')
        ];
        for (const operation of operations) {
            operation();
            const snapshot = await service.get(document);
            expect(snapshot.timing.inputMode).toBe('edits');
            expect(snapshot.timing.local).toBe(true);
            expect(snapshot.timing.inputChars).toBeLessThan(30);
            await expectFresh(document, snapshot);
        }
        expect(getText).not.toHaveBeenCalled();
    });
    it('applies multi-cursor changes in old-document coordinates and coalesces successive events', async () => {
        const document = doc('module top(input clk);\nreg [7:0] a;\nreg [7:0] b;\nreg [7:0] c;\nendmodule');
        await service.get(document);
        const offsets = ['a', 'c'].map(name => document.source.indexOf(`[7:0] ${name}`));
        const changes = offsets.map(start => ({ rangeOffset: start, rangeLength: 5, text: '[31:0]',
            range: { start: position(document.source, start), end: position(document.source, start + 5) } }));
        let source = document.source;
        for (const change of [...changes].reverse()) {
            source = source.slice(0, change.rangeOffset) + change.text + source.slice(change.rangeOffset + change.rangeLength);
        }
        edit(document, source); service.changed(document, changes);
        patch(document, document.source.indexOf('reg [7:0] b;'), 0, 'reg inserted;\n');
        const snapshot = await service.get(document);
        expect(snapshot.timing.editCount).toBe(3);
        expect(snapshot.timing.inputMode).toBe('edits');
        await expectFresh(document, snapshot);
    });
    it('keeps event edits arriving during a worker request', async () => {
        const document = doc('module top; reg a; endmodule');
        const pending = service.get(document);
        patch(document, document.source.indexOf('reg a;'), 6, 'reg b;');
        patch(document, document.source.indexOf('reg b;'), 6, 'wire latest;');
        expect(service.entries.get(document.uri.fsPath).timer).toBeUndefined();
        const snapshot = await pending;
        expect(snapshot.version).toBe(document.version);
        expect(snapshot.timing.inputMode).toBe('edits');
        await expectFresh(document, snapshot);
    });

    it('updates comments and whitespace between units without extracting their bodies', async () => {
        const document = doc('// intro\nmodule top; reg a; endmodule\n// between\nmodule other; wire b; endmodule\n// tail');
        await service.get(document);
        for (const [before, after] of [
            ['// intro', '// 中文 😀 intro\n'],
            ['// between', '\n/* module fake; reg fake; endmodule */'],
            ['// tail', '// changed tail\r\n']
        ]) {
            patch(document, document.source.indexOf(before), before.length, after);
            const snapshot = await service.get(document);
            expect(snapshot.timing.extraction).toBe('trivia');
            await expectFresh(document, snapshot);
        }
    });

    it('keeps clean module edits local when another module has a temporary syntax error', async () => {
        const document = doc('module broken; wire [ x; endmodule\nmodule clean(input clk); reg a; always @(posedge clk) a <= 1; endmodule');
        await service.get(document);
        patch(document, document.source.indexOf('a <= 1') + 'a <= '.length, 1, '2');
        const snapshot = await service.get(document);
        expect(snapshot.timing.extraction).toBe('expression');
        await expectFresh(document, snapshot);
    });

    it('reconciles body constants whose first textual occurrence enters or leaves the header', async () => {
        const document = doc('module top(output [BODY-1:0] data);\nparameter BODY=2;\nreg a;\nendmodule');
        await service.get(document);
        for (const [before, after] of [['[BODY-1:0]', '[3:0]'], ['[3:0]', '[BODY-1:0]']]) {
            patch(document, document.source.indexOf(before), before.length, after);
            const snapshot = await service.get(document);
            expect(snapshot.timing.extraction).toBe('header');
            await expectFresh(document, snapshot);
        }
    });

    it('re-extracts parameter identities to expose a body default shadowed by the old header', async () => {
        const document = doc('module top #(parameter P=1)();\nparameter P=2;\nreg a;\nendmodule');
        await service.get(document);
        const before = '#(parameter P=1)';
        patch(document, document.source.indexOf(before), before.length, '');
        const snapshot = await service.get(document);
        expect(snapshot.timing.extraction).toBe('module');
        expect(snapshot.modules[0].parameters).toEqual([{ name: 'P', defaultValue: '2' }]);
        await expectFresh(document, snapshot);
    });

    it('invalidates flat-module scope assumptions when introducing nested design units', async () => {
        const document = doc('module top(input clk); reg a; endmodule');
        await service.get(document);
        const nested = 'module nested; wire n; endmodule\n';
        const start = document.source.indexOf('reg a;');
        patch(document, start, 0, nested);
        let snapshot = await service.get(document);
        expect(snapshot.timing.scopeMode).toBe('text');
        await expectFresh(document, snapshot);
        patch(document, document.source.indexOf('input clk'), 9, 'inout clk');
        snapshot = await service.get(document);
        expect(snapshot.timing.scopeMode).toBe('text');
        await expectFresh(document, snapshot);
        patch(document, start, nested.length, '');
        snapshot = await service.get(document);
        expect(snapshot.timing.scopeMode).toBe('syntax');
        await expectFresh(document, snapshot);
    });

    it('handles batches spanning header/body and separate modules conservatively', async () => {
        const document = doc('module top(input clk);\nreg a;\nendmodule\nmodule other; wire b; endmodule');
        await service.get(document);
        patch(document, document.source.indexOf('input clk'), 9, 'inout clk');
        patch(document, document.source.indexOf('reg a;'), 6, 'reg [7:0] a;');
        let snapshot = await service.get(document);
        expect(snapshot.timing.extraction).toBe('module');
        await expectFresh(document, snapshot);
        patch(document, document.source.indexOf('reg [7:0] a;'), 12, 'reg [3:0] a;');
        patch(document, document.source.indexOf('wire b;'), 7, 'wire [2:0] b;');
        snapshot = await service.get(document);
        expect(snapshot.timing.extraction).toBe('module');
        await expectFresh(document, snapshot);
        patch(document, document.source.indexOf('reg [3:0] a;'), 0, 'wire inserted;\n');
        patch(document, document.source.indexOf('wire [2:0] b;'), 13, 'wire [15:0] b;');
        snapshot = await service.get(document);
        expect(snapshot.timing.extraction).toBe('module');
        await expectFresh(document, snapshot);
    });
    it('resynchronizes when worker state is missing and when an event is missed', async () => {
        const document = doc('module top; reg a; endmodule');
        await service.get(document);
        service.worker.postMessage({ close: true, filePath: document.uri.fsPath });
        patch(document, document.source.indexOf('reg a;'), 6, 'wire b;');
        let snapshot = await service.get(document);
        expect(snapshot.timing.inputMode).toBe('full');
        await expectFresh(document, snapshot);
        edit(document, document.source.replace('wire b;', 'reg c;'));
        snapshot = await service.get(document);
        expect(snapshot.timing.inputMode).toBe('full');
        await expectFresh(document, snapshot);
    });
    it('falls back to full sync after worker restart and after an oversized event batch', async () => {
        const document = doc('module top; reg a; endmodule');
        await service.get(document);
        await service.worker.terminate();
        patch(document, document.source.indexOf('reg a;'), 6, 'wire b;');
        let snapshot = await service.get(document);
        expect(snapshot.timing.inputMode).toBe('full');
        await expectFresh(document, snapshot);
        for (let index = 0; index < 129; index++) { patch(document, document.source.indexOf('wire b;'), 0, ' '); }
        snapshot = await service.get(document);
        expect(snapshot.timing.inputMode).toBe('full');
        await expectFresh(document, snapshot);
    });
    it('updates procedural ranges locally when adding and removing body blocks', async () => {
        const document = doc('module top(input clk);\nreg a;\ninitial begin a = 0; end\nalways @(posedge clk) begin a <= 1; end\nendmodule');
        await service.get(document);
        patch(document, document.source.indexOf('initial'), 0, 'always @(negedge clk) begin reg local_signal; local_signal = a; end\n');
        let snapshot = await service.get(document);
        expect(snapshot.timing.local).toBe(true);
        await expectFresh(document, snapshot);
        const start = document.source.indexOf('always @(negedge');
        patch(document, start, document.source.indexOf('initial') - start, '');
        snapshot = await service.get(document);
        expect(snapshot.timing.local).toBe(true);
        await expectFresh(document, snapshot);
    });

    it('extracts function/task edits locally and survives temporary syntax errors and undo', async () => {
        const document = doc(`module top;
reg a;
function automatic [7:0] f(input [7:0] x);
    reg [7:0] tmp_f;
    begin tmp_f = x; f = tmp_f; end
endfunction
task t(input x);
    reg tmp_task;
    begin tmp_task = x; end
endtask
endmodule`);
        const original = document.source;
        await service.get(document);
        for (const [before, after] of [['reg [7:0] tmp_f;', 'reg [15:0] tmp_f;'], ['reg tmp_task;', 'reg [3:0] tmp_task;']]) {
            patch(document, document.source.indexOf(before), before.length, after);
            const snapshot = await service.get(document);
            expect(snapshot.timing.local).toBe(true);
            await expectFresh(document, snapshot);
        }
        patch(document, document.source.indexOf('reg a;') + 5, 1, '');
        await expectFresh(document, await service.get(document));
        patch(document, 0, document.source.length, original);
        await expectFresh(document, await service.get(document));
    });

    it('parses an accumulated edit stream correctly after piece-table compaction', async () => {
        const document = doc('module top(input clk);\n' + Array.from({ length: 100 }, (_, index) => `reg [7:0] s_${index};`).join('\n') + '\nendmodule');
        await service.get(document);
        const getText = jest.spyOn(document, 'getText').mockImplementation(() => { throw new Error('Unexpected full read'); });
        for (let index = 0; index < 70; index++) {
            patch(document, document.source.indexOf(`[7:0] s_${index};`) + 1, 1, '9');
        }
        const snapshot = await service.get(document);
        expect(snapshot.timing.inputMode).toBe('edits');
        expect(snapshot.timing.editCount).toBe(70);
        expect(snapshot.timing.pieces).toBeLessThanOrEqual(64);
        await expectFresh(document, snapshot);
        expect(getText).not.toHaveBeenCalled();
    });

    it('preserves symbol identity for expression edits but invalidates deleted declarations', async () => {
        const document = doc('module top(input clk);\nreg a;\nalways @(posedge clk) a <= 1;\nendmodule');
        const initial = await service.get(document);
        patch(document, document.source.indexOf('a <= 1') + 'a <= '.length, 1, '2');
        let snapshot = await service.get(document);
        expect(snapshot.timing.local).toBe(true);
        expect(snapshot.symbols).toBe(initial.symbols);
        await expectFresh(document, snapshot);
        patch(document, document.source.indexOf('reg a;'), 6, '/*xx*/');
        snapshot = await service.get(document);
        expect(snapshot.symbols).not.toBe(initial.symbols);
        expect(snapshot.symbols.some((symbol: any) => symbol.name === 'a')).toBe(false);
        await expectFresh(document, snapshot);
    });

    it('keeps structural edits incremental in transport and equivalent to fresh extraction', async () => {
        const document = doc('module top #(parameter WIDTH=8)(input clk, output [WIDTH-1:0] data);\nreg a;\ngenerate if (1) begin : g wire generated; end endgenerate\nendmodule\nmodule other; reg b; endmodule');
        await service.get(document);
        const getText = jest.spyOn(document, 'getText').mockImplementation(() => { throw new Error('Unexpected full read'); });
        for (const [before, after, extraction] of [
            ['input clk', 'inout clk, input reset', 'header'],
            ['WIDTH=8', 'WIDTH=16', 'header'],
            ['module top', 'module renamed', 'header'],
            ['if (1)', 'if (0)', 'items'],
            ['wire generated;', 'wire [WIDTH-1:0] added, generated;', 'items'],
            ['module other; reg b; endmodule', 'module appended(input x); reg c; endmodule\nmodule other; reg b; endmodule', 'full'],
            ['module appended(input x); reg c; endmodule\n', '', 'full']
        ]) {
            patch(document, document.source.indexOf(before), before.length, after);
            const snapshot = await service.get(document);
            expect(snapshot.timing.inputMode).toBe('edits');
            expect(snapshot.timing.extraction).toBe(extraction);
            await expectFresh(document, snapshot);
        }
        expect(getText).not.toHaveBeenCalled();
    });

    it('refreshes non-ANSI ports without retaining old directions or names', async () => {
        const document = doc('module top(a,b);\ninput a;\noutput [7:0] b;\nendmodule\nmodule other; wire c; endmodule');
        await service.get(document);
        for (const [before, after] of [
            ['output [7:0] b;', 'inout [15:0] b;'],
            ['top(a,b)', 'top(a,renamed)'],
            ['[15:0] b;', '[15:0] renamed;']
        ]) {
            patch(document, document.source.indexOf(before), before.length, after);
            const snapshot = await service.get(document);
            expect(snapshot.timing.inputMode).toBe('edits');
            await expectFresh(document, snapshot);
        }
    });

    it('derives ordinary module scopes from syntax and preserves lexical recovery for mixed units', async () => {
        for (const source of [
            'module top(input clk); reg a; endmodule',
            '(* keep = "true" *)\nmodule top; reg a; endmodule : top',
            'interface bus; logic data; endinterface\nmodule top; reg a; endmodule',
            'module top; reg a; endmodule\nmodule unfinished;'
        ]) {
            const document = doc(source);
            const snapshot = await service.get(document);
            expect(snapshot.scopes).toEqual(getCompletionScopes(source));
            if (source === 'module top(input clk); reg a; endmodule') { expect(snapshot.timing.scopeMode).toBe('syntax'); }
            service.close(document);
        }
    });

});
