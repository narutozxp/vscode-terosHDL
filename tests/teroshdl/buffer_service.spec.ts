import * as path from 'path';

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
});
