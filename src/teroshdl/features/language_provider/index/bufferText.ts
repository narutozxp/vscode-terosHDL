/** UTF-16 offsets match VS Code and web-tree-sitter's JavaScript input callback. */
export interface BufferEdit {
    startIndex: number;
    oldEndIndex: number;
    text: string;
    startPosition: { row: number; column: number };
    oldEndPosition: { row: number; column: number };
    newEndPosition: { row: number; column: number };
}

interface Backing { text: string }
interface Piece { source: Backing; start: number; end: number }

function upperBound(values: number[], offset: number): number {
    let low = 0; let high = values.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (values[middle] <= offset) { low = middle + 1; } else { high = middle; }
    }
    return low;
}

/** Persistent pieces: edits copy descriptors, not the document; old trees retain their own input. */
export class BufferText {
    private pieces: Piece[];
    private ends: number[];
    private lines: number[];
    private backingChars = 0;
    readonly length: number;

    constructor(source: string, pieces?: Piece[], lines?: number[]) {
        this.pieces = pieces ?? (source.length ? [{ source: { text: source }, start: 0, end: source.length }] : []);
        const backings = new Set<Backing>();
        for (const piece of this.pieces) {
            if (!backings.has(piece.source)) {
                backings.add(piece.source); this.backingChars += piece.source.text.length;
            }
        }
        let length = 0;
        this.ends = this.pieces.map(piece => length += piece.end - piece.start);
        this.length = length;
        this.lines = lines ?? [0];
        if (!lines) {
            for (let index = 0; index < source.length; index++) {
                if (source.charCodeAt(index) === 10) { this.lines.push(index + 1); }
            }
        }
    }

    get pieceCount(): number { return this.pieces.length; }
    get retainedChars(): number { return this.backingChars; }

    slice(start: number, end = this.length): string {
        start = Math.max(0, Math.min(start, this.length));
        end = Math.max(start, Math.min(end, this.length));
        const parts: string[] = [];
        let index = upperBound(this.ends, start);
        while (index < this.pieces.length && start < end) {
            const piece = this.pieces[index];
            const base = index ? this.ends[index - 1] : 0;
            const finish = Math.min(end, this.ends[index]);
            parts.push(piece.source.text.slice(piece.start + start - base, piece.start + finish - base));
            start = finish; index++;
        }
        return parts.length === 1 ? parts[0] : parts.join('');
    }

    toString(): string { return this.slice(0); }

    point(offset: number): { row: number; column: number } {
        const row = Math.max(0, upperBound(this.lines, offset) - 1);
        return { row, column: offset - this.lines[row] };
    }

    edit(edit: BufferEdit): BufferText {
        const { startIndex: start, oldEndIndex: end, text } = edit;
        if (start < 0 || end < start || end > this.length ||
            !Number.isInteger(start) || !Number.isInteger(end)) { throw new Error('Invalid buffer edit'); }
        const delta = text.length - (end - start);
        const insertedLines: number[] = [];
        for (let index = 0; index < text.length; index++) {
            if (text.charCodeAt(index) === 10) { insertedLines.push(start + index + 1); }
        }
        const first = upperBound(this.lines, start);
        const last = upperBound(this.lines, end);
        // Most keystrokes do not affect line positions when replacing equal-length text.
        const lines = !delta && first === last && !insertedLines.length ? this.lines : [
            ...this.lines.slice(0, first), ...insertedLines,
            ...this.lines.slice(last).map(offset => offset + delta)
        ];
        const pieces: Piece[] = [];
        const append = (from: number, to: number) => {
            let index = upperBound(this.ends, from);
            while (index < this.pieces.length && from < to) {
                const piece = this.pieces[index];
                const base = index ? this.ends[index - 1] : 0;
                const finish = Math.min(to, this.ends[index]);
                pieces.push({ source: piece.source, start: piece.start + from - base, end: piece.start + finish - base });
                from = finish; index++;
            }
        };
        append(0, start);
        if (text.length) { pieces.push({ source: { text }, start: 0, end: text.length }); }
        append(end, this.length);
        const result = new BufferText('', pieces, lines);
        // Bound fragmentation and release obsolete backing strings periodically.
        if (pieces.length > 64 || result.retainedChars > 2 * result.length + 65536) {
            // A one-piece slice can retain its large parent string in V8. Force independent
            // storage; UTF-16 also preserves edits that temporarily split a surrogate pair.
            const compacted = Buffer.from(result.toString(), 'utf16le').toString('utf16le');
            return new BufferText(compacted, undefined, lines);
        }
        return result;
    }
}
