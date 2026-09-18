import { getCompletionScopes } from '../../src/teroshdl/features/language_provider/ctags/providers/completionScopes';

const { BufferLanguageService } = require('../../out/teroshdl/features/language_provider/index/bufferService');

describe('Live parsing syntax and edit boundaries', () => {
    let service: any;
    beforeEach(() => { service = new BufferLanguageService(() => {}); });
    afterEach(() => service.dispose());
    const document = (source: string, path = '/tmp/live-boundary.sv') => ({
        uri: { scheme: 'file', fsPath: path, toString: () => `file://${path}` }, languageId: 'systemverilog', version: 1,
        source, getText() { return this.source; }
    });
    const position = (source: string, offset: number) => {
        const rows = source.slice(0, offset).split('\n');
        return { line: rows.length - 1, character: rows[rows.length - 1].length };
    };
    function patch(doc: any, start: number, length: number, text: string) {
        const changes = [{ rangeOffset: start, rangeLength: length, text,
            range: { start: position(doc.source, start), end: position(doc.source, start + length) } }];
        doc.source = doc.source.slice(0, start) + text + doc.source.slice(start + length);
        doc.version++;
        service.changed(doc, changes);
    }
    const normalize = (snapshot: any) => ({
        modules: snapshot.modules.map(({ filePath, ...model }: any) => model), scopes: snapshot.scopes,
        symbols: snapshot.symbols.map((record: any) => ({ ...record })).sort((a: any, b: any) =>
            a.offset - b.offset || a.type.localeCompare(b.type) || a.name.localeCompare(b.name))
    });
    async function fresh(doc: any, snapshot: any) {
        expect(snapshot.scopes).toEqual(getCompletionScopes(doc.source));
        const oracle = document(doc.source, '/tmp/live-boundary-oracle.sv');
        try { expect(normalize(snapshot)).toEqual(normalize(await service.get(oracle))); }
        finally { service.close(oracle); }
        for (const symbol of snapshot.symbols) {
            const start = position(doc.source, symbol.offset);
            expect({ line: symbol.line, character: symbol.column }).toEqual(start);
        }
    }
    const ordinary = 'module top(input clk); reg a; endmodule';
    it.each([
        ['empty file creation', '', '', ordinary],
        ['empty file trivia', '', '', '\n// module fake; endmodule\n'],
        ['whole file deletion', ordinary, ordinary, ''],
        ['EOF append', ordinary, 'endmodule', 'endmodule\nmodule appended; wire w; endmodule'],
        ['final newline', ordinary + '\n', '\n', ''],
        ['BOM insertion', ordinary, 'module top', '\uFEFFmodule top'],
        ['line ending conversion', 'module top;\nreg a;\nendmodule', '\nreg a;\n', '\r\nreg a;\r\n'],
        ['tab formatting', ordinary, ' reg a; ', '\n\treg a;\n'],
        ['EOF line comment', ordinary + '\n// tail', '// tail', '// tail module fake; reg bogus; endmodule'],
        ['unclosed block comment', ordinary, 'reg a;', '/* reg a;'],
        ['block comment close', 'module top; /* reg a;\nendmodule', '/* reg a;', '/* ignored */ reg a;'],
        ['unclosed string', ordinary, 'reg a;', 'string msg="unterminated;'],
        ['string escape and comma', ordinary, 'reg a;', 'string msg="a,\\\"endmodule\\\""; reg a;'],
        ['escaped module', 'module \\top.name ; reg a; endmodule', '\\top.name ', '\\changed::name '],
        ['escaped ANSI port', 'module top(input \\clk.name ); reg a; endmodule', '\\clk.name ', '\\clk::changed '],
        ['escaped parameter', 'module top #(parameter \\P.name =1)(); reg a; endmodule', '\\P.name ', '\\P.changed '],
        ['module automatic lifetime', ordinary, 'module top', 'module automatic top'],
        ['module static lifetime', ordinary, 'module top', 'module static top'],
        ['macromodule keyword', ordinary, 'module top', 'macromodule top'],
        ['unfinished module body', ordinary, 'endmodule', ''],
        ['attribute with name in string', ordinary, 'module top', '(* note="clk a" *) module top'],
        ['multiline module attribute', ordinary, 'module top', '(* keep="true" *)\nmodule top'],
        ['body attribute', ordinary, 'reg a;', '(* keep="true" *) reg a;'],
        ['ANSI default value', ordinary, 'input clk', "input logic clk=1'b0"],
        ['ANSI port default expression', ordinary, 'input clk', "input logic [3:0] clk={2{2'b01}}"],
        ['non-ANSI external port', 'module top(.external(internal)); input internal; endmodule', '.external(internal)', '.renamed(internal)'],
        ['interface modport port', 'module top(bus.master link); reg a; endmodule', 'bus.master', 'bus.slave'],
        ['parameter system function', 'module top #(parameter P=$clog2(16))(); reg a; endmodule', '$clog2(16)', '$clog2(32)'],
        ['parameter balanced comma', 'module top #(parameter P=1)(); reg a; endmodule', 'P=1', 'P={2{4\'hA}}'],
        ['parameter multiline default', 'module top #(parameter P=1)(); reg a; endmodule', 'P=1', 'P=(\n1+2\n)'],
        ['parameter quoted comma', 'module top #(parameter P="a,b")(); reg a; endmodule', '"a,b"', '"a,endmodule,b"'],
        ['parameter comment before identifier', 'module top; parameter /* P */ P=1; endmodule', '/* P */', '/* changed */'],
        ['comment with body parameter name', 'module top; // P\nparameter P=1; reg a; endmodule', '// P', '// changed'],
        ['string with body parameter name', 'module top; string msg="P"; parameter P=1; endmodule', '"P"', '"changed"'],
        ['parameter referenced before declaration', 'module top(output [P-1:0] data); parameter P=2; endmodule', '[P-1:0]', '[3:0]'],
        ['parameter in earlier comment insertion', 'module top; parameter P=1; endmodule', 'parameter P', '// P\nparameter P'],
        ['function body parameter', 'module top; function f; parameter P=1; f=P; endfunction endmodule', 'P=1', 'P=2'],
        ['nested module parameter', 'module top; module nested; parameter P=1; endmodule reg a; endmodule', 'P=1', 'P=2'],
        ['named block local variable', ordinary, 'reg a;', 'initial begin : named reg a; a=0; end'],
        ['fork/join block', ordinary, 'reg a;', 'reg a; initial fork a=0; a=1; join'],
        ['always_comb', ordinary, 'reg a;', 'reg a; always_comb begin a=0; end'],
        ['always_latch', ordinary, 'reg a;', 'reg a; always_latch if (clk) a=1;'],
        ['function return type', 'module top; function logic f(input x); f=x; endfunction endmodule', 'logic f', 'logic [3:0] f'],
        ['task body deletion', 'module top; task t; reg tmp; tmp=0; endtask endmodule', 'reg tmp; tmp=0;', ''],
        ['implicit generate', ordinary, 'reg a;', 'if (1) begin : g reg a; end'],
        ['generate case', ordinary, 'reg a;', 'generate case (1) 1: begin : g reg a; end endcase endgenerate'],
        ['generate region removal', 'module top; generate if (1) begin : g wire a; end endgenerate endmodule', 'generate if (1) begin : g wire a; end endgenerate', 'wire a;'],
        ['primitive instance', ordinary, 'reg a;', 'wire a; and primitive_gate(a,clk,clk);'],
        ['multiple instances', ordinary, 'reg a;', 'child first(.clk(clk)), second(.clk(clk));'],
        ['wildcard instance connection', ordinary, 'reg a;', 'child inst(.*);'],
        ['bind statement', ordinary, 'reg a;', 'reg a; bind top checker check_inst();'],
        ['specify timing block', ordinary, 'reg a;', 'reg a; specify (clk => a) = 1; endspecify'],
        ['assertion property', ordinary, 'reg a;', 'reg a; assert property (@(posedge clk) a);'],
        ['clocking block', ordinary, 'reg a;', 'reg a; clocking cb @(posedge clk); input a; endclocking'],
        ['class declaration', ordinary, 'reg a;', 'class c; int field; function new(); endfunction endclass reg a;'],
        ['covergroup declaration', ordinary, 'reg a;', 'reg a; covergroup cg; cp: coverpoint a; endgroup'],
        ['compilation-unit parameter', ordinary, 'module top', 'parameter GLOBAL=1; module top'],
        ['compilation-unit typedef', ordinary, 'module top', 'typedef int global_t; module top'],
        ['package import', ordinary, 'reg a;', 'import definitions::*; reg a;'],
        ['compiler directive', ordinary, 'module top', '`timescale 1ns/1ps\nmodule top'],
        ['default_nettype directive', ordinary, 'reg a;', '`default_nettype none\nreg a;'],
        ['macro function definition', ordinary, 'reg a;', '`define ADD(x,y) ((x)+(y))\nreg a;'],
        ['macro undefinition', ordinary, 'reg a;', '`undef FEATURE\nreg a;'],
        ['line continuation macro', ordinary, 'reg a;', '`define ADD(x,y) ((x)+\\\n(y))\nreg a;'],
        ['include path rename', ordinary + '\n`include "a.svh"', '"a.svh"', '"b.svh"'],
        ['conditional else branch', ordinary, 'reg a;', '`ifdef FEATURE\nreg a;\n`else\nwire a;\n`endif'],
        ['endmodule label rename', ordinary + ' : top', ': top', ': renamed'],
        ['semicolon temporary error', ordinary, 'reg a;', 'reg a'],
        ['parenthesis temporary error', ordinary, 'input clk)', 'input clk'],
        ['module keyword temporary error', ordinary, 'module top', 'modul top']
    ])('matches fresh parsing and positions for %s', async (_label, source, before, after) => {
        const doc = document(source);
        await service.get(doc);
        const read = jest.spyOn(doc, 'getText').mockImplementation(() => { throw new Error('Unexpected full read'); });
        const start = source.indexOf(before);
        expect(start).toBeGreaterThanOrEqual(0);
        patch(doc, start, before.length, after);
        let snapshot = await service.get(doc);
        expect(snapshot.timing.inputMode).toBe('edits');
        await fresh(doc, snapshot);
        patch(doc, start, after.length, before);
        snapshot = await service.get(doc);
        await fresh(doc, snapshot);
        expect(read).not.toHaveBeenCalled();
    });

    it('isolates authorities and URI queries when virtual buffers share an fsPath', async () => {
        const a: any = document('module first; wire a; endmodule');
        const b: any = document('module second; wire b; endmodule');
        const c: any = document('module third; wire c; endmodule');
        a.uri = { scheme: 'memory', fsPath: '/same.sv', toString: () => 'memory://host/same.sv?one' };
        b.uri = { scheme: 'memory', fsPath: '/same.sv', toString: () => 'memory://other/same.sv?two' };
        c.uri = { scheme: 'memory', fsPath: '/same.sv', toString: () => 'memory://host/same.sv?two' };
        const [first, second, third] = await Promise.all([service.get(a), service.get(b), service.get(c)]);
        expect(first.modules[0].name).toBe('first'); expect(second.modules[0].name).toBe('second');
        expect(third.modules[0].name).toBe('third');
        patch(b, b.source.indexOf('wire b;'), 7, 'wire [3:0] b;');
        await fresh(b, await service.get(b));
        service.close(a);
        expect((await service.get(b)).modules[0].name).toBe('second');
        expect(service.entries.size).toBe(2);
    });

    it('keeps exact columns after horizontal edits in several units on one line', async () => {
        const doc = document('module first(input clk); reg a; endmodule module second(input x); wire b; endmodule');
        await service.get(doc);
        patch(doc, doc.source.indexOf('reg a;'), 6, 'reg [15:0] a;');
        await fresh(doc, await service.get(doc));
        patch(doc, doc.source.indexOf('input clk'), 9, 'input reset');
        await fresh(doc, await service.get(doc));
    });

    it('starts a new lifetime for a different document object with the same URI and version', async () => {
        const old = document('module old; wire stale; endmodule');
        await service.get(old);
        const reopened = document('module latest; wire fresh; endmodule');
        const snapshot = await service.get(reopened);
        expect(snapshot.modules[0].name).toBe('latest');
        expect(snapshot.symbols.some((record: any) => record.name === 'stale')).toBe(false);
        await fresh(reopened, snapshot);
    });

    it('does not restart a worker for closed documents', async () => {
        const doc: any = document(ordinary);
        doc.isClosed = true;
        service.changed(doc, []);
        await expect(service.get(doc)).rejects.toThrow('Document closed');
        expect(service.entries.size).toBe(0); expect(service.worker).toBeUndefined();
    });

    it('anchors public parameters to declarations rather than earlier mentions', async () => {
        const source = 'module top #(parameter /* P */ P=1, Q=2)(output [BODY-1:0] data);\n// BODY\nparameter BODY=3; endmodule';
        const doc = document(source);
        const snapshot = await service.get(doc);
        expect(snapshot.modules[0].parameters).toEqual([
            { name: 'P', defaultValue: '1' }, { name: 'Q', defaultValue: '2' }, { name: 'BODY', defaultValue: '3' }
        ]);
        for (const name of ['P', 'Q', 'BODY']) {
            const record = snapshot.symbols.find((record: any) => record.type === 'constant' && record.name === name);
            expect(record.offset).toBe(source.indexOf(`${name}=`));
        }
        expect(snapshot.symbols.filter((record: any) => record.name === 'BODY' && record.type === 'constant')).toHaveLength(1);
    });

    it('recreates the worker after fatal initialization replies', async () => {
        const doc = document(ordinary);
        const pending = service.get(doc);
        const rejected = expect(pending).rejects.toThrow('Initialization failed');
        const id = [...service.pending.keys()][0];
        service.worker.emit('message', { id, fatal: true, error: 'Initialization failed' });
        await rejected;
        expect(service.worker).toBeUndefined();
        await fresh(doc, await service.get(doc));
    });

    it('resynchronizes invalid range offsets instead of returning saved stale state', async () => {
        const doc = document(ordinary);
        await service.get(doc);
        doc.source = doc.source.replace('reg a;', 'wire latest;'); doc.version++;
        service.changed(doc, [{ rangeOffset: 99999, rangeLength: 0, text: 'latest',
            range: { start: { line: 0, character: 99999 }, end: { line: 0, character: 99999 } } }]);
        const snapshot = await service.get(doc);
        expect(snapshot.timing.inputMode).toBe('full');
        await fresh(doc, snapshot);
    });

    it('updates suffix columns when net length and newline counts stay equal', async () => {
        const doc = document('module top; always begin a=1;\nb=2; end wire suffix; endmodule');
        const initial = await service.get(doc);
        const before = 'a=1;\nb=2;'; const after = 'a=1;b=\n2;';
        patch(doc, doc.source.indexOf(before), before.length, after);
        const snapshot = await service.get(doc);
        expect(snapshot.symbols).not.toBe(initial.symbols);
        await fresh(doc, snapshot);
    });

    it('preserves unfinished scope sentinels when earlier assignments insert newlines', async () => {
        const doc = document('module clean; reg a; initial a=1; endmodule\nmodule unfinished;');
        await service.get(doc);
        patch(doc, doc.source.indexOf('a=1') + 2, 1, '(\n2\n)');
        const snapshot = await service.get(doc);
        expect(snapshot.timing.extraction).toBe('expression');
        expect(snapshot.scopes[snapshot.scopes.length - 1].endLine).toBe(Number.MAX_SAFE_INTEGER);
        await fresh(doc, snapshot);
    });

    it('handles deep procedural nesting without recursive symbol collection', async () => {
        const depth = 700;
        const doc = document('module top; initial ' + 'begin '.repeat(depth) + 'reg deep; deep=1; ' + 'end '.repeat(depth) + 'endmodule');
        let snapshot = await service.get(doc);
        expect(snapshot.symbols.some((record: any) => record.name === 'deep')).toBe(true);
        patch(doc, doc.source.indexOf('deep=1'), 6, 'deep=2');
        snapshot = await service.get(doc);
        await fresh(doc, snapshot);
    });

    it('skips declaration traversal for assignment edits in a large procedural block', async () => {
        const doc = document('module top; initial begin\n' + Array.from({ length: 3000 }, (_, index) => `reg [7:0] local_${index};`).join('\n') +
            '\nlocal_0=1; end endmodule');
        const initial = await service.get(doc);
        patch(doc, doc.source.indexOf('local_0=1') + 'local_0='.length, 1, '2');
        const snapshot = await service.get(doc);
        expect(snapshot.timing.extraction).toBe('expression');
        expect(snapshot.symbols).toBe(initial.symbols);
        await fresh(doc, snapshot);
        // Injecting declarations leaves the proved assignment and must re-extract.
        patch(doc, doc.source.indexOf('local_0=2') + 'local_0='.length, 1, '2; reg inserted; local_0=3');
        const changed = await service.get(doc);
        expect(changed.timing.extraction).not.toBe('expression');
        expect(changed.symbols.some((record: any) => record.name === 'inserted')).toBe(true);
        await fresh(doc, changed);
    });

    it('collects generated declarations beyond JavaScript spread-argument limits', async () => {
        const count = 160000;
        const doc = document('module top; reg [7:0] ' + Array.from({ length: count }, (_, index) => `s_${index}`).join(',') + '; endmodule');
        const snapshot = await service.get(doc);
        const registers = snapshot.symbols.filter((record: any) => record.type === 'register');
        expect(registers).toHaveLength(count);
        expect(registers[0].name).toBe('s_0'); expect(registers[count - 1].name).toBe(`s_${count - 1}`);
        expect(registers[0].outlineDetail).toBe('reg [7:0]');
        expect(registers[count - 1].outlineDetail).toBe('reg [7:0]');
    }, 30000);
});
