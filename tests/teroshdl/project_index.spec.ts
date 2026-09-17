import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileSymbolCache } from '../../src/teroshdl/features/language_provider/index/fileCache';
import { ProjectSymbolIndex } from '../../src/teroshdl/features/language_provider/index/projectIndex';
import { VerilogProjectParser } from '../../src/colibri/parser/ts_verilog/project_model';
import { getInstanceContext } from '../../src/teroshdl/features/language_provider/index/instanceContext';

describe('Saved file cache and project module index', () => {
    let directory: string;
    let cache: FileSymbolCache;
    beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zhdl-index-')); });
    afterEach(() => { cache?.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
    const write = (directory: string, name: string, source: string) => {
        const file = path.join(directory, name); fs.writeFileSync(file, source); return file;
    };

    it('shares concurrent loads and reuses an unchanged snapshot', async () => {
        const file = write(directory, 'test.v', 'module a; endmodule\nmodule b; endmodule');
        const load = jest.fn(async () => []);
        cache = new FileSymbolCache(load);
        const snapshots = await Promise.all([cache.get(file), cache.get(file), cache.get(file)]);
        expect(load).toHaveBeenCalledTimes(1);
        expect(snapshots[0]).toBe(snapshots[1]);
        expect(await cache.get(file)).toBe(snapshots[0]);
        expect(snapshots[0].modules.map(module => module.name)).toEqual(['a', 'b']);
    });

    it('discards an older in-flight result after a saved-file change', async () => {
        const file = write(directory, 'test.tcl', 'old');
        let release: () => void;
        let started: () => void;
        const ready = new Promise<void>(resolve => { started = resolve; });
        const gate = new Promise<void>(resolve => { release = resolve; });
        const load = jest.fn(async (_file: string, source: string) => {
            if (source === 'old') { started(); await gate; } return [];
        });
        cache = new FileSymbolCache(load);
        const old = cache.get(file);
        await ready;
        fs.writeFileSync(file, 'new content'); cache.invalidate(file);
        const latest = await cache.get(file);
        release();
        expect(await old).toBe(latest);
        expect(cache.peek(file).source).toBe('new content');
        expect(load).toHaveBeenCalledTimes(2);
    });

    it('retries failures and never publishes a failed snapshot', async () => {
        const file = write(directory, 'test.tcl', 'data');
        const load = jest.fn().mockRejectedValueOnce(new Error('ctags failed')).mockResolvedValue([]);
        cache = new FileSymbolCache(load);
        await expect(cache.get(file)).rejects.toThrow('ctags failed');
        expect(cache.peek(file)).toBeUndefined();
        expect((await cache.get(file)).source).toBe('data');
    });

    it('limits parsing to two files at a time', async () => {
        let active = 0; let peak = 0;
        const releases: (() => void)[] = [];
        let twoStarted: () => void;
        const ready = new Promise<void>(resolve => { twoStarted = resolve; });
        cache = new FileSymbolCache(async () => {
            active++; peak = Math.max(peak, active);
            if (releases.length < 2) {
                const gate = new Promise<void>(resolve => releases.push(resolve));
                if (releases.length === 2) { twoStarted(); }
                await gate;
            }
            active--; return [];
        });
        const pending = Promise.all(Array.from({ length: 6 }, (_, index) =>
            cache.get(write(directory, `${index}.tcl`, 'data'))));
        await ready; expect(peak).toBe(2); releases.forEach(resolve => resolve()); await pending;
        expect(peak).toBe(2);
    });

    it('retries a temporary project indexing failure on the next request', async () => {
        const file = write(directory, 'retry.v', 'module recovered; endmodule');
        const load = jest.fn().mockRejectedValueOnce(new Error('temporary')).mockResolvedValue([]);
        cache = new FileSymbolCache(load);
        const errors = jest.fn(); const index = new ProjectSymbolIndex(cache, errors);
        index.setFiles('main', [file]);
        expect(await index.modules('main')).toEqual([]);
        expect(errors).toHaveBeenCalledTimes(1);
        expect((await index.modules('main')).map(module => module.name)).toEqual(['recovered']);
        index.dispose();
    });

    it('updates only invalidated files and isolates project membership', async () => {
        const first = write(directory, 'first.v', 'module first(input clk); endmodule');
        const second = write(directory, 'second.v', 'module second; endmodule');
        const other = write(directory, 'other.v', 'module unrelated; endmodule');
        const load = jest.fn(async () => []); cache = new FileSymbolCache(load);
        const index = new ProjectSymbolIndex(cache, (_file, error) => { throw error; });
        index.setFiles('main', [first, second]); index.setFiles('other', [other]);
        expect((await index.modules('main')).map(module => module.name).sort()).toEqual(['first', 'second']);
        await index.modules('main'); expect(load).toHaveBeenCalledTimes(2);
        expect((await index.modules('other')).map(module => module.name)).toEqual(['unrelated']);
        fs.writeFileSync(first, 'module renamed(input reset); endmodule'); cache.invalidate(first);
        expect((await index.modules('main')).map(module => module.name).sort()).toEqual(['renamed', 'second']);
        expect(load).toHaveBeenCalledTimes(4);
        index.setFiles('main', [first]);
        expect((await index.modules('main')).map(module => module.name)).toEqual(['renamed']);
        index.dispose();
    });
});

describe('Module interfaces and instance connection contexts', () => {
    it('extracts every module, inherited declarations and public parameters', async () => {
        const parser = new VerilogProjectParser();
        try {
            const modules = await parser.parse(`module fifo #(parameter WIDTH=8, SIZE=2)(
                input wire [WIDTH-1:0] a, b, output reg ready);
                localparam PRIVATE=1;
                always @(*) begin ready = a[0]; end
                endmodule
                module legacy(b,a); input a; output [3:0] b; endmodule`, '/project/fifo.sv');
            expect(modules.map(module => module.name)).toEqual(['fifo', 'legacy']);
            expect(modules[0].ports.map(port => port.name)).toEqual(['a', 'b', 'ready']);
            expect(modules[0].ports[1].declaration).toBe('input wire [WIDTH-1:0]');
            expect(modules[0].parameters).toEqual([{ name: 'WIDTH', defaultValue: '8' }, { name: 'SIZE', defaultValue: '2' }]);
            expect(modules[0].proceduralRanges).toHaveLength(1);
            expect(modules[0].bodyStart).toBeLessThan(modules[0].proceduralRanges[0].start);
            expect(modules[1].ports.map(port => port.name)).toEqual(['b', 'a']);
        } finally { parser.dispose(); }
    });

    function context(marked: string) {
        const offset = marked.indexOf('|');
        return getInstanceContext(marked.replace('|', ''), offset, new Set(['fifo']));
    }
    it('completes unfinished named ports and excludes connections on both sides', () => {
        const result = context('module top; fifo u(.clk(clk), .|, .data(data)); endmodule');
        expect(result.kind).toBe('ports'); expect(result.moduleName).toBe('fifo');
        expect([...result.usedNames]).toEqual(['clk', 'data']);
        expect(context('module top; fifo u(.cl|k(clk)); endmodule').usedNames.size).toBe(0);
        expect(context('module top; fifo u( .|').kind).toBe('ports');
    });
    it('uses ordinary signal completion inside a connection expression', () => {
        expect(context('module top; fifo u(.clk(|)); endmodule')).toBeUndefined();
        expect(context('module top; fifo u(.clk(f(a,b|)), .data(d)); endmodule')).toBeUndefined();
    });
    it('recognizes parameters, instance arrays and multiple instances', () => {
        expect(context('module top; fifo #(.WIDTH(8), .|) u(); endmodule').kind).toBe('parameters');
        expect(context('module top; fifo u0(), u1[3:0](.|); endmodule').instanceName).toBe('u1');
    });
    it('limits hierarchical members to the current module', () => {
        expect(context('module top; fifo u(); assign x=u.|; endmodule').kind).toBe('members');
        expect(context('module first; fifo u(); endmodule module second; assign x=u.|; endmodule')).toBeUndefined();
        expect(context('module top; // fifo u();\nassign x=u.|; endmodule')).toBeUndefined();
    });
});
