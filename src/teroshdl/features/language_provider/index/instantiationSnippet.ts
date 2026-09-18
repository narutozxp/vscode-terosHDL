import { SnippetString } from 'vscode';
import type { VerilogModule, VerilogPort } from 'colibri/parser/ts_verilog/project_model';
import { verilogTokens } from 'colibri/parser/ts_verilog/project_model';

function hdlName(name: string): string { return name.startsWith('\\') ? name + ' ' : name; }

function portComment(port: VerilogPort): string {
    const tokens = verilogTokens(port.declaration);
    const ranges: string[] = [];
    const types: string[] = [];
    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        if (token.text !== '[') { types.push(token.text); continue; }
        let depth = 1;
        let end = index + 1;
        for (; end < tokens.length; end++) {
            if (tokens[end].text === '[') { depth++; }
            if (tokens[end].text === ']' && --depth === 0) { break; }
        }
        if (depth === 0) {
            ranges.push(tokens.slice(index, end + 1).map(part => part.text).join(''));
            index = end;
        }
    }
    const integerWidths: Record<string, number> = { byte: 8, shortint: 16, int: 32, integer: 32, longint: 64, time: 64 };
    const scalarTypes = new Set(['input', 'output', 'inout', 'ref', 'wire', 'reg', 'logic', 'bit',
        'tri', 'tri0', 'tri1', 'wand', 'wor', 'triand', 'trior', 'trireg', 'uwire',
        'supply0', 'supply1', 'interconnect', 'signed', 'unsigned', 'var', 'const']);
    const integer = types.find(type => integerWidths[type]);
    const width = ranges.join('') || (integer ? `[${integerWidths[integer] - 1}:0]` :
        types.length && types.every(type => scalarTypes.has(type)) ? '[0:0]' : 'width unknown');
    const direction = port.direction || types.find(type => /^(input|output|inout|ref)$/.test(type)) || 'direction unknown';
    return `${direction} ${width}`;
}

export function buildInstantiationSnippet(module: VerilogModule): SnippetString {
    const snippet = new SnippetString();
    let placeholder = 2;
    snippet.appendText(hdlName(module.name) + ' ');
    if (module.parameters.length) {
        snippet.appendText('#(\n');
        module.parameters.forEach((parameter, index) => {
            snippet.appendText(`\t.${hdlName(parameter.name)}(`);
            snippet.appendPlaceholder(parameter.defaultValue || parameter.name, placeholder++);
            snippet.appendText(')' + (index < module.parameters.length - 1 ? ',' : '') + '\n');
        });
        snippet.appendText(') ');
    }
    snippet.appendPlaceholder('instance_name', 1);
    snippet.appendText(' (');
    if (module.ports.length) {
        snippet.appendText('\n');
        let width = 0; let connectionWidth = 0;
        module.ports.forEach((port, index) => {
            const length = hdlName(port.name).length;
            width = Math.max(width, length);
            connectionWidth = Math.max(connectionWidth, length + (index < module.ports.length - 1 ? 1 : 0));
        });
        module.ports.forEach((port, index) => {
            snippet.appendText(`\t.${hdlName(port.name).padEnd(width)}(`);
            snippet.appendPlaceholder(hdlName(port.name), placeholder++);
            const comma = index < module.ports.length - 1 ? ',' : '';
            const padding = ' '.repeat(connectionWidth - hdlName(port.name).length - comma.length + 1);
            snippet.appendText(')' + comma + `${padding}// ${portComment(port)}\n`);
        });
    }
    snippet.appendText(');');
    snippet.appendTabstop(0);
    return snippet;
}
