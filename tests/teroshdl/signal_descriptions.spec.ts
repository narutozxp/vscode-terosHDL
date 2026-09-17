import { getSignalDescriptions } from '../../src/teroshdl/features/language_provider/ctags/providers/signalDescriptions';

describe('Signal completion declaration descriptions', () => {
    function description(source: string, name: string, type = 'register', line = 0): string | undefined {
        const symbol = { name, type, startPosition: { line } };
        return getSignalDescriptions(source, [symbol]).get(symbol);
    }

    it('reads packed ranges separately for ports on the same line', () => {
        const source = 'module top(input logic [WIDTH-1:0] data, input wire clk, output reg [3:0] ready);';
        expect(description(source, 'data', 'port')).toBe('input logic [WIDTH-1:0]');
        expect(description(source, 'clk', 'port')).toBe('input wire [0:0]');
        expect(description(source, 'ready', 'port')).toBe('output reg [3:0]');
    });

    it('preserves shared widths and excludes unpacked arrays and initializer bit selections', () => {
        const source = 'reg [7:0] count [0:15], other = data[3:0];';
        const symbols = ['count', 'other'].map(name => ({ name, type: 'register', startPosition: { line: 0 } }));
        const descriptions = getSignalDescriptions(source, symbols);
        expect(symbols.map(symbol => descriptions.get(symbol))).toEqual(['reg [7:0]', 'reg [7:0]']);
    });

    it('reads multiline ranges and ignores misleading comments and strings', () => {
        expect(description('wire /* [99:0] */\n [DATA_WIDTH-1:0]\n bus;', 'bus', 'net', 2))
            .toBe('wire [DATA_WIDTH-1:0]');
        expect(description('string note = "wire [99:0] bus"; wire bus;', 'bus', 'net')).toBe('wire [0:0]');
    });

    it('supports multiple packed dimensions and integer defaults', () => {
        expect(description('logic [1:0][7:0] value;', 'value')).toBe('logic [1:0][7:0]');
        expect(description('int value;', 'value')).toBe('int [31:0]');
    });

    it('keeps inherited widths after function and concatenation initializers', () => {
        const source = 'wire [7:0] first = fn(data[3:0]), second = {high, low}, third;';
        const symbols = ['first', 'second', 'third'].map(name => ({ name, type: 'net', startPosition: { line: 0 } }));
        const descriptions = getSignalDescriptions(source, symbols);
        expect(symbols.map(symbol => descriptions.get(symbol))).toEqual(['wire [7:0]', 'wire [7:0]', 'wire [7:0]']);
    });

    it('does not invent a scalar width for a typedef port', () => {
        expect(description('module top(input packet_t packet);', 'packet', 'port')).toBe('input');
    });

    it('distinguishes bidirectional ports and inherits direction across shared declarations', () => {
        const source = 'module top(input wire [7:0] a, b, output reg ready, inout wire [3:0] bus);';
        expect(description(source, 'a', 'port')).toBe('input wire [7:0]');
        expect(description(source, 'b', 'port')).toBe('input wire [7:0]');
        expect(description(source, 'ready', 'port')).toBe('output reg [0:0]');
        expect(description(source, 'bus', 'port')).toBe('inout wire [3:0]');
        expect(description('output reg [15:0] data;', 'data', 'port')).toBe('output reg [15:0]');
        expect(description('module top(input wire a, reg [3:0] b);', 'b', 'port')).toBe('input reg [3:0]');
    });
});
