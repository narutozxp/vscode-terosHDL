import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const supported = process.platform === 'linux' && process.arch === 'x64';
(supported ? describe : describe.skip)('Bundled Linux ctags configuration', () => {
    let directory: string;
    beforeAll(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zhdl-ctags-')); });
    afterAll(() => { fs.rmSync(directory, { recursive: true, force: true }); });

    function tags(name: string, source: string): string[][] {
        const file = path.join(directory, name);
        fs.writeFileSync(file, source);
        const root = path.resolve(__dirname, '../..');
        return execFileSync(path.join(root, 'resources/bin/ctags/universal-ctags-linux'), [
            `--options=${path.join(root, 'resources/bin/ctags/.ctags')}`,
            '-f', '-', '--fields=+K', '--sort=no', '--excmd=n', file
        ], { encoding: 'utf8' }).trim().split('\n').map(line => line.split('\t'));
    }

    it('keeps the symbol kinds and scope fields consumed by the completion provider', () => {
        const result = tags('example.sv', [
            'module demo(input wire clk, output reg ready);',
            'reg count;', 'wire active;', 'logic valid;',
            'fifo #(.WIDTH(8)) u_fifo(.clk(clk));', 'endmodule'
        ].join('\n'));
        for (const [name, kind] of [
            ['clk', 'port'], ['ready', 'port'], ['count', 'register'],
            ['active', 'net'], ['valid', 'register']
        ]) {
            const tag = result.find(fields => fields[0] === name);
            expect(tag?.slice(3)).toEqual([kind, 'module:demo']);
        }
        expect(result.find(fields => fields[0] === 'u_fifo')?.slice(3))
            .toEqual(['instance', 'module:demo', 'typeref:module:fifo']);
    });

    it('keeps custom VHDL and Tcl parsers working alongside built-in parsers', () => {
        expect(tags('example.vhd', 'entity demo is\nsignal count : integer;\n')
            .map(fields => [fields[0], fields[3]]))
            .toEqual([['demo', 'entity'], ['count', 'signal']]);
        expect(tags('example.tcl', 'set project demo\n')[0][3]).toBe('global');
    });
});
