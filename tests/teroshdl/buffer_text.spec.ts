import { BufferText, BufferEdit } from '../../src/teroshdl/features/language_provider/index/bufferText';

function point(source: string, offset: number) {
    const prefix = source.slice(0, offset).split('\n');
    return { row: prefix.length - 1, column: prefix[prefix.length - 1].length };
}
function edit(source: string, start: number, end: number, text: string): BufferEdit {
    const updated = source.slice(0, start) + text + source.slice(end);
    return { startIndex: start, oldEndIndex: end, text, startPosition: point(source, start),
        oldEndPosition: point(source, end), newEndPosition: point(updated, start + text.length) };
}

describe('Persistent parser input', () => {
    it('matches string slices and positions through random UTF-16 edits and compaction', () => {
        let source = 'module top;\r\n// 中文 😀\nreg a;\nendmodule\n';
        let buffer = new BufferText(source);
        let seed = 42;
        const random = (limit: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % limit; };
        const inserts = ['a', '\n', '\r\n', '😀', '中文', '', 'reg [7:0] b;', '/*\n*/'];
        for (let index = 0; index < 500; index++) {
            const start = random(source.length + 1);
            const end = Math.min(source.length, start + random(8));
            const text = inserts[random(inserts.length)];
            const previous = buffer;
            const old = source;
            buffer = buffer.edit(edit(source, start, end, text));
            source = source.slice(0, start) + text + source.slice(end);
            expect(previous.toString()).toBe(old);
            expect(buffer.toString()).toBe(source);
            expect(buffer.length).toBe(source.length);
            expect(buffer.pieceCount).toBeLessThanOrEqual(64);
            for (const offset of [0, source.length, start, ...Array.from({ length: 5 }, () => random(source.length + 1))]) {
                expect(buffer.point(Math.min(offset, source.length))).toEqual(point(source, Math.min(offset, source.length)));
            }
            const sliceStart = random(source.length + 1);
            expect(buffer.slice(sliceStart, sliceStart + 17)).toBe(source.slice(sliceStart, sliceStart + 17));
        }
    });
    it('compacts a long insertion history while preserving old snapshots', () => {
        let source = 'a'.repeat(1000);
        let buffer = new BufferText(source);
        const initial = buffer;
        for (let index = 0; index < 200; index++) {
            const offset = index * 3;
            buffer = buffer.edit(edit(source, offset, offset, 'x'));
            source = source.slice(0, offset) + 'x' + source.slice(offset);
        }
        expect(buffer.toString()).toBe(source);
        expect(buffer.pieceCount).toBeLessThanOrEqual(64);
        expect(initial.toString()).toBe('a'.repeat(1000));
    });
    it('releases oversized backing text after a large deletion', () => {
        const source = 'a'.repeat(100000);
        const initial = new BufferText(source);
        const result = initial.edit(edit(source, 50, 99950, ''));
        expect(result.length).toBe(100);
        expect(result.retainedChars).toBe(100);
        expect(result.toString()).toBe('a'.repeat(100));
        expect(initial.toString()).toBe(source);
    });
    it('preserves unpaired UTF-16 code units when compacting a single surviving slice', () => {
        const source = '😀'.repeat(50000);
        const result = new BufferText(source).edit(edit(source, 1, source.length, ''));
        expect(result.toString()).toBe(source.slice(0, 1));
        expect(result.retainedChars).toBe(1);
    });
});
