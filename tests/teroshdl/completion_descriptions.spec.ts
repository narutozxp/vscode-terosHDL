import { CompletionItem, CompletionItemKind, TextDocument } from 'vscode';
import { Ctags, CtagsManager, Symbol } from '../../src/teroshdl/features/language_provider/ctags/ctags';
import CompletionProvider from '../../src/teroshdl/features/language_provider/ctags/providers/CompletionItemProvider';
import { Logger } from '../../src/teroshdl/features/language_provider/ctags/Logger';
import { VerilogProjectParser } from '../../src/colibri/parser/ts_verilog/project_model';
import { FileSymbolCache } from '../../src/teroshdl/features/language_provider/index/fileCache';
import { ProjectLanguageService } from '../../src/teroshdl/features/language_provider/index/projectService';
import { buildInstantiationSnippet } from '../../src/teroshdl/features/language_provider/index/instantiationSnippet';
import { GlobalConfigManager } from '../../src/colibri/config/config_manager';

beforeEach(() => GlobalConfigManager.newInstance(''));

jest.mock('vscode', () => ({
    Position: class { constructor(public line: number, public character: number) {} },
    Range: class { constructor(public start: { line: number }) {} },
    MarkdownString: class { constructor(public value: string) {} },
    CompletionItem: class { constructor(public label: unknown, public kind: unknown) {} },
    SnippetString: class {
        value = '';
        appendText(text: string) { this.value += text.replace(/[\\$}]/g, '\\$&'); return this; }
        appendPlaceholder(text: string, index: number) { this.value += '${' + index + ':' + text.replace(/[\\$}]/g, '\\$&') + '}'; return this; }
        appendTabstop(index: number) { this.value += '$' + index; return this; }
    },
    DocumentSymbol: class { constructor(public name: string, public detail: string, public kind: unknown) {} },
    CompletionItemKind: { Keyword: 1, Variable: 2, Field: 3, Module: 4, Interface: 5 },
    SymbolKind: { Field: 3, Variable: 2, Module: 4 }
}), { virtual: true });

describe('Outline details and completion labels from ctags symbols', () => {
    const logger = { log: jest.fn() } as unknown as Logger;
    const provider = new CompletionProvider(logger);
    const uri = { toString: () => 'file:///example.sv' };

    it('retains both scope and module type when ctags emits additional fields', () => {
        const parser = new Ctags(logger, undefined);
        const tag = parser.parseTagLine('u_fifo\texample.sv\t4;"\tinstance\tmodule:top\ttyperef:module:pkg::fifo')[0];
        expect(tag.parentScope).toBe('top');
        expect(tag.parentType).toBe('module');
        expect(tag.typeRef).toBe('pkg::fifo');
    });

    it('filters other modules’ ports and variables when requesting completion', async () => {
        const source = 'module first(input first_clk);\nreg first_data;\nendmodule\nmodule second(input second_clk);\nreg second_data;\nendmodule';
        let cursor = source.indexOf('reg first_data');
        const document = {
            uri, languageId: 'verilog', version: 1, offsetAt: () => cursor,
            getText: (range?: { start: { line: number } }) => range ? source.split('\n')[range.start.line] : source
        } as unknown as TextDocument;
        const parser = new Ctags(logger, undefined);
        parser.doc = document;
        parser.symbols = [
            'first\texample.sv\t1;"\tmodule',
            'first_clk\texample.sv\t1;"\tport\tmodule:first',
            'first_data\texample.sv\t2;"\tregister\tmodule:first',
            'second\texample.sv\t4;"\tmodule',
            'second_clk\texample.sv\t4;"\tport\tmodule:second',
            'second_data\texample.sv\t5;"\tregister\tmodule:second'
        ].flatMap(tag => parser.parseTagLine(tag));
        CtagsManager.ctags = parser;
        const first = await provider.provideCompletionItems(document, undefined, undefined, undefined) as CompletionItem[];
        expect(first.map(item => item.insertText)).toEqual(expect.arrayContaining(['first', 'second', 'first_clk', 'first_data', 'always']));
        expect(first.map(item => item.insertText)).not.toEqual(expect.arrayContaining(['second_clk']));
        expect(first.map(item => item.insertText)).not.toEqual(expect.arrayContaining(['second_data']));
        cursor = source.indexOf('reg second_data');
        const second = await provider.provideCompletionItems(document, undefined, undefined, undefined) as CompletionItem[];
        expect(second.map(item => item.insertText)).toEqual(expect.arrayContaining(['second_clk', 'second_data']));
        expect(second.map(item => item.insertText)).not.toEqual(expect.arrayContaining(['first_clk']));
    });

    it('displays signal metadata in completion labels and Outline', async () => {
        const source = 'module top(input wire [15:0] data);\nreg [7:0] count;\nwire clk;\nfifo u_fifo();\n';
        const parser = new Ctags(logger, undefined);
        const tags = [
            'data\texample.sv\t1;"\tport\tmodule:top',
            'count\texample.sv\t2;"\tregister\tmodule:top',
            'clk\texample.sv\t3;"\tnet\tmodule:top',
            'u_fifo\texample.sv\t4;"\tinstance\tmodule:top\ttyperef:module:fifo'
        ];
        CtagsManager.ctags = parser;
        const document = {
            uri, languageId: 'verilog', version: 1,
            offsetAt: () => source.indexOf('reg'),
            getText: (range?: { start: { line: number } }) => range ? source.split('\n')[range.start.line] : source
        } as unknown as TextDocument;
        parser.doc = document;
        await parser.buildSymbolsList(tags.join('\n'));
        expect(parser.symbols.map(symbol => symbol.getDocumentSymbol().detail)).toEqual([
            'input wire [15:0]', 'reg [7:0]', 'wire [0:0]', 'instance fifo'
        ]);
        const items = await provider.provideCompletionItems(document, undefined, undefined, undefined) as CompletionItem[];
        const symbols = items.filter(item => item.insertText && ['data', 'count', 'clk', 'u_fifo'].includes(String(item.insertText)));
        expect(symbols.map(item => item.label)).toEqual([
            { label: 'data', detail: ' input wire [15:0]', description: 'port' },
            { label: 'count', detail: ' reg [7:0]', description: 'reg' },
            { label: 'clk', detail: ' wire [0:0]', description: 'wire' },
            { label: 'u_fifo', description: 'instance' }
        ]);
        expect(symbols.map(item => item.insertText)).toEqual(['data', 'count', 'clk', 'u_fifo']);
        expect(symbols[3].kind).toBe(CompletionItemKind.Field);
        expect(symbols[0].kind).toBe(CompletionItemKind.Interface);
        expect(symbols[1].kind).toBe(CompletionItemKind.Variable);
        expect(symbols[2].kind).toBe(CompletionItemKind.Variable);
        expect(Symbol.getSymbolKind('instance')).not.toBe(Symbol.getSymbolKind('net'));

        const changed = source.replace('[7:0]', '[31:0]');
        Object.assign(document, { version: 2, getText: () => changed });
        const updated = await provider.provideCompletionItems(document, undefined, undefined, undefined) as CompletionItem[];
        expect(updated.find(item => item.insertText === 'count').label)
            .toEqual({ label: 'count', detail: ' reg [7:0]', description: 'reg' });
        parser.clearSymbols();
        await parser.buildSymbolsList(tags.join('\n'));
        expect(parser.symbols.find(symbol => symbol.name === 'count').getDocumentSymbol().detail).toBe('reg [31:0]');
    });
});

describe('Project module completion and instantiation', () => {
    const logger = { log: jest.fn() } as unknown as Logger;
    const parser = new VerilogProjectParser();
    afterAll(() => parser.dispose());
    async function items(marked: string) {
        const cursor = marked.indexOf('|'); const source = marked.replace('|', '');
        const external = await parser.parse('module fifo #(parameter WIDTH=$clog2(16))(input clk, input [WIDTH-1:0] data, output ready); endmodule', '/project/fifo.sv');
        const local = await parser.parse(source, '/project/top.sv');
        const document = {
            uri: { scheme: 'file', fsPath: '/project/top.sv', toString: () => 'file:///project/top.sv' },
            languageId: 'systemverilog', version: 1, getText: () => source,
            offsetAt: () => cursor, getWordRangeAtPosition: () => undefined
        } as unknown as TextDocument;
        const cache = { get: async () => ({ source, symbols: [], modules: local }) } as unknown as FileSymbolCache;
        const project = { modules: async () => [...external, ...local] } as unknown as ProjectLanguageService;
        return await new CompletionProvider(logger, cache, project).provideCompletionItems(document, undefined, undefined, undefined) as CompletionItem[];
    }
    it('generates named parameters, ports and editable instance name with numbered tabstops', async () => {
        const result = await items('module top;\n fi|\nendmodule');
        const fifo = result.find(item => (item.label as any).label === 'fifo');
        const snippet = (fifo.insertText as any).value.replace(/ +\/\//g, ' //');
        expect(snippet).toContain('${1:instance_name}');
        expect(snippet).toContain('.WIDTH(${2:\\$clog2(16)})');
        expect(snippet).toContain('${3:clk}'); expect(snippet).toContain('${4:data}');
        expect(snippet).toContain('${5:ready}'); expect(snippet.endsWith(');$0')).toBe(true);
        expect(snippet).toContain('(${3:clk}), // input [0:0]\n');
        expect(snippet).toContain('(${4:data}), // input [WIDTH-1:0]\n');
        expect(snippet).toContain('(${5:ready}) // output [0:0]\n');
        expect((fifo.label as any).description).toBe('module');
    });
    it('annotates inherited ports, packed dimensions, integers and legacy declarations', async () => {
        const modules = await parser.parse(`module example(input [7:0] a, b,
            inout wire [1:0][3:0] bus, output integer count, input custom_t typed); endmodule
            module legacy(clk,data); input clk; output reg [15:0] data; endmodule`, '/project/example.sv');
        const rawSnippet = buildInstantiationSnippet(modules[0]).value;
        const rendered = rawSnippet.replace(/\$\{\d+:([^}]*)\}/g, '$1');
        const commentColumns = rendered.split('\n').filter(line => line.includes('//')).map(line => line.indexOf('//'));
        expect(new Set(commentColumns).size).toBe(1);
        const snippet = rawSnippet.replace(/ +\/\//g, ' //');
        expect(snippet).toContain('(${2:a}), // input [7:0]\n');
        expect(snippet).toContain('(${3:b}), // input [7:0]\n');
        expect(snippet).toContain('(${4:bus}), // inout [1:0][3:0]\n');
        expect(snippet).toContain('(${5:count}), // output [31:0]\n');
        expect(snippet).toContain('(${6:typed}) // input width unknown\n');
        const legacy = buildInstantiationSnippet(modules[1]).value.replace(/ +\/\//g, ' //');
        expect(legacy).toContain('(${2:clk}), // input [0:0]\n');
        expect(legacy).toContain('(${3:data}) // output [15:0]\n');
    });
    it('offers only unconnected ports after a dot', async () => {
        const result = await items('module top; fifo u(.clk(clk), .|); endmodule');
        expect(result.map(item => (item.label as any).label)).toEqual(['data', 'ready']);
        expect((result[0].insertText as any).value).toBe('data(${1:data})$0');
        expect(result.every(item => item.kind === CompletionItemKind.Interface)).toBe(true);
        expect(result.map(item => (item.label as any).detail)).toEqual([' input wire [WIDTH-1:0]', ' output wire [0:0]']);
    });
    it('offers named parameter overrides and hierarchical instance ports', async () => {
        const parameters = await items('module top; fifo #(.|) u(); endmodule');
        expect(parameters.map(item => (item.label as any).label)).toEqual(['WIDTH']);
        const members = await items('module top; fifo u(); assign x=u.|; endmodule');
        expect(members.map(item => item.insertText)).toEqual(['clk', 'data', 'ready']);
    });
    it('inserts plain module names inside procedural blocks and connection expressions', async () => {
        for (const source of ['module top;\n always @(*) begin\n fi|\n end\nendmodule',
            'module top;\n fifo u(.clk(\n fi|\n));\nendmodule']) {
            const result = await items(source);
            expect(result.find(item => (item.label as any).label === 'fifo').insertText).toBe('fifo');
        }
    });
});

describe('Unsaved signal completion with live parsing enabled', () => {
    it('shows new signals and updated widths even with an incomplete following statement', async () => {
        const config = GlobalConfigManager.getInstance().get_config();
        config.general.general.live_parsing = true;
        GlobalConfigManager.getInstance().set_config(config);
        const cache = new FileSymbolCache(async () => []);
        // The production worker executes compiled JavaScript outside ts-jest.
        const { BufferLanguageService } = require('../../out/teroshdl/features/language_provider/index/bufferService');
        cache.buffers.dispose();
        (cache as any).buffers = new BufferLanguageService(() => {});
        let source = 'module top(input clk);\nreg [7:0] added;\nadd\nendmodule';
        const document = {
            uri: { scheme: 'file', fsPath: '/tmp/zhdl-completion-live.sv', toString: () => 'file:///tmp/zhdl-completion-live.sv' },
            languageId: 'systemverilog', version: 1, getText: () => source,
            offsetAt: () => source.lastIndexOf('add\n'), getWordRangeAtPosition: () => undefined
        } as unknown as TextDocument;
        try {
            const provider = new CompletionProvider({ log() {} } as any, cache);
            let items = await provider.provideCompletionItems(document, undefined, undefined, undefined);
            expect(items.find(item => item.insertText === 'added').label)
                .toEqual({ label: 'added', detail: ' reg [7:0]', description: 'reg' });
            source = source.replace('[7:0]', '[31:0]'); (document as any).version++;
            items = await provider.provideCompletionItems(document, undefined, undefined, undefined);
            expect(items.find(item => item.insertText === 'added').label)
                .toEqual({ label: 'added', detail: ' reg [31:0]', description: 'reg' });
        } finally {
            cache.dispose();
        }
    });
});
