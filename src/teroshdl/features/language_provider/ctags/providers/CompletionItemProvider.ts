// The MIT License (MIT)

// Copyright (c) 2016 Masahiro H

// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:

// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.

// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

import {
    CompletionItemProvider, CompletionItem, TextDocument, Position,
    CancellationToken, CompletionContext, ProviderResult, CompletionItemKind,
    Range, MarkdownString, SnippetString
} from "vscode";
import { Ctags, CtagsManager } from '../ctags';
import { getKeywords } from './keywords';
import { getCompletionScopes, getVisibleCompletionSymbols } from './completionScopes';
import { Logger } from "../Logger";
import { FileSymbolCache } from '../../index/fileCache';
import type { ProjectLanguageService } from '../../index/projectService';
import type { VerilogModule } from 'colibri/parser/ts_verilog/project_model';
import { verilogTokens } from 'colibri/parser/ts_verilog/project_model';
import { getInstanceContext, InstanceContext } from '../../index/instanceContext';
import { buildInstantiationSnippet } from '../../index/instantiationSnippet';
import { getSignalDescriptions } from './signalDescriptions';
import { getIndexingSettings } from '../../index/settings';

export default class VerilogCompletionItemProvider implements CompletionItemProvider {

    private logger: Logger;
    private scopeCache?: { document: TextDocument; version: number; scopes: ReturnType<typeof getCompletionScopes> };

    constructor(logger: Logger, private cache: FileSymbolCache = CtagsManager.fileCache,
        private project?: ProjectLanguageService) {
        this.logger = logger;
    }

    async provideCompletionItems(document: TextDocument, position: Position, token: CancellationToken,
        context: CompletionContext): Promise<CompletionItem[]> {
        this.logger.log("Completion items requested");
        const verilog = ['verilog', 'systemverilog'].includes(document.languageId);
        const version = document.version;
        const source = document.getText();
        const live = verilog && getIndexingSettings().liveParsing;
        let modules: VerilogModule[] = [];
        let symbols: Ctags['symbols'] = [];
        let savedSource: string | undefined;
        try {
            if (this.cache && document.uri.scheme === 'file') {
                const [snapshot, projectModules] = await Promise.all([
                    (live ? this.cache.getBuffer(document).catch(error => {
                        this.logger.log(`Live parsing failed, using saved symbols: ${error}`); return this.cache.get(document.uri.fsPath);
                    }) : this.cache.get(document.uri.fsPath)).catch(error => { this.logger.log(`Completion indexing failed: ${error}`); return undefined; }),
                    verilog && this.project ? this.project.modules(document).catch(error => {
                        this.logger.log(`Project indexing failed: ${error}`); return [];
                    }) : Promise.resolve([])
                ]);
                symbols = snapshot?.symbols ?? [];
                savedSource = snapshot?.source;
                modules = projectModules;
            } else {
                const ctags = CtagsManager.ctags;
                if (ctags?.doc?.uri.toString() === document.uri.toString()) { symbols = ctags.symbols; }
            }
        } catch (error) { this.logger.log(`Completion indexing failed: ${error}`); }
        if (token?.isCancellationRequested || document.version !== version) { return []; }

        if (verilog && (this.scopeCache?.document !== document || this.scopeCache.version !== document.version)) {
            this.scopeCache = { document, version: document.version, scopes: getCompletionScopes(source) };
        }
        const offset = verilog ? document.offsetAt(position) : 0;
        if (verilog && modules.length) {
            const instance = getInstanceContext(source, offset, new Set(modules.map(module => module.name)));
            if (instance) { return this.instanceItems(document, position, modules, instance); }
        }

        const items = getKeywords(document.languageId).map(keyword => {
            const item = new CompletionItem({ label: keyword, description: 'keyword' }, CompletionItemKind.Keyword);
            item.detail = 'keyword';
            item.insertText = keyword;
            return item;
        });
        const visible = verilog ? getVisibleCompletionSymbols(symbols, this.scopeCache.scopes, offset) : symbols;
        const savedLines = savedSource?.split('\n');
        for (const symbol of visible) {
            if (symbol.type === 'module' && modules.length) { continue; }
            const description = symbol.type === 'register' ? 'reg' : symbol.type === 'net' ? 'wire' : symbol.type;
            const metadata = ['port', 'register', 'net'].includes(symbol.type) ? symbol.outlineDetail : undefined;
            const label = metadata ? { label: symbol.name, detail: ' ' + metadata, description } : { label: symbol.name, description };
            const item = new CompletionItem(label, this.getCompletionItemKind(symbol.type));
            item.insertText = symbol.name;
            item.detail = metadata ?? description;
            const code = savedLines !== undefined ? savedLines[symbol.startPosition.line]?.trim() ?? '' :
                document.getText(new Range(symbol.startPosition, new Position(symbol.startPosition.line, Number.MAX_VALUE))).trim();
            item.documentation = new MarkdownString("\`\`\`" + document.languageId + "\n" + code + "\n\`\`\`" +
                (symbol.parentScope ? "\nHierarchical Scope: " + symbol.parentScope : ""));
            items.push(item);
        }
        for (const module of modules) {
            const active = modules.find(candidate => candidate.filePath === document.uri.fsPath &&
                candidate.start <= offset && offset <= candidate.end);
            const canInstantiate = active && active.bodyStart <= offset &&
                !active.proceduralRanges.some(range => range.start <= offset && offset <= range.end) &&
                this.statementStart(source, offset, active.bodyStart);
            const item = new CompletionItem({
                label: module.name, detail: canInstantiate ? ' instantiate' : '', description: 'module'
            }, CompletionItemKind.Module);
            item.filterText = module.name;
            item.insertText = canInstantiate ? buildInstantiationSnippet(module) : module.name;
            item.detail = `module — ${module.filePath}:${module.line + 1}`;
            item.documentation = new MarkdownString(`Instantiate ${module.name} with ${module.ports.length} ports.\n\n${module.filePath}`);
            items.push(item);
        }
        this.logger.log(items.length + " items requested");
        return items;
    }

    private statementStart(source: string, offset: number, bodyStart: number): boolean {
        const line = source.slice(source.lastIndexOf('\n', offset - 1) + 1, offset);
        if (!/^[ \t]*(?:[a-zA-Z_$][\w$]*|\\[^\s]*)?$/.test(line)) { return false; }
        let depth = 0;
        for (const token of verilogTokens(source.slice(bodyStart, offset))) {
            if (['(', '[', '{'].includes(token.text)) { depth++; }
            if ([')', ']', '}'].includes(token.text)) { depth--; }
        }
        return depth === 0;
    }

    private instanceItems(document: TextDocument, position: Position, modules: VerilogModule[],
        instance: InstanceContext): CompletionItem[] {
        const local = modules.filter(module => module.name === instance.moduleName && module.filePath === document.uri.fsPath);
        const definitions = local.length ? local : modules.filter(module => module.name === instance.moduleName);
        const items: CompletionItem[] = [];
        const word = document.getWordRangeAtPosition(position);
        const end = word ? document.offsetAt(word.end) : document.offsetAt(position);
        const hasParenthesis = /^\s*\(/.test(document.getText().slice(end));
        for (const module of definitions) {
            const members = instance.kind === 'parameters' ? module.parameters.map(parameter => ({
                name: parameter.name, declaration: 'parameter', defaultValue: parameter.defaultValue
            })) : module.ports.map(port => ({ name: port.name, declaration: port.declaration, defaultValue: port.name }));
            for (const member of members) {
                if (instance.usedNames.has(member.name)) { continue; }
                const description = instance.kind === 'parameters' ? 'parameter' : 'port';
                const signal = { name: member.name, type: 'port', startPosition: { line: 0 } };
                const declaration = member.declaration.replace(/\s+/g, ' ');
                const metadata = instance.kind === 'parameters' ? undefined :
                    getSignalDescriptions(`${declaration} ${member.name};`, [signal]).get(signal);
                const item = new CompletionItem({ label: member.name,
                    ...(metadata ? { detail: ' ' + metadata } : {}),
                    description: definitions.length > 1 ? `${description} · ${module.filePath}` : description
                }, instance.kind === 'parameters' ? CompletionItemKind.Constant : CompletionItemKind.Interface);
                item.detail = `${member.declaration}\n${module.name} — ${module.filePath}`;
                item.range = word;
                if (instance.kind === 'members' || hasParenthesis) {
                    item.insertText = member.name;
                } else {
                    const snippet = new SnippetString();
                    snippet.appendText((instance.hasDot ? '' : '.') + member.name + (member.name.startsWith('\\') ? ' ' : '') + '(');
                    snippet.appendPlaceholder(member.defaultValue, 1);
                    snippet.appendText(')');
                    snippet.appendTabstop(0);
                    item.insertText = snippet;
                }
                items.push(item);
            }
        }
        return items;
    }

    private getCompletionItemKind(type: string): CompletionItemKind {
        switch (type) {
            case 'constant': return CompletionItemKind.Constant;
            case 'event': return CompletionItemKind.Event;
            case 'function': return CompletionItemKind.Function;
            case 'module': return CompletionItemKind.Module;
            case 'instance': return CompletionItemKind.Field;
            case 'entity': return CompletionItemKind.Module; //VHDL
            case 'net': return CompletionItemKind.Variable;
            case 'port': return CompletionItemKind.Interface;
            case 'register': return CompletionItemKind.Variable;
            case 'signal': return CompletionItemKind.Variable; //VHDL
            case 'task': return CompletionItemKind.Function;
            case 'block': return CompletionItemKind.Module;
            case 'assert': return CompletionItemKind.Variable;   // No idea what to use
            case 'class': return CompletionItemKind.Class;
            case 'covergroup': return CompletionItemKind.Class;  // No idea what to use
            case 'enum': return CompletionItemKind.Enum;
            case 'interface': return CompletionItemKind.Interface;
            case 'modport': return CompletionItemKind.Variable;    // same as ports
            case 'package': return CompletionItemKind.Module;
            case 'program': return CompletionItemKind.Module;
            case 'process': return CompletionItemKind.Method; //VHDL
            case 'prototype': return CompletionItemKind.Function;
            case 'property': return CompletionItemKind.Property;
            case 'struct': return CompletionItemKind.Struct;
            case 'typedef': return CompletionItemKind.TypeParameter;
            default: return CompletionItemKind.Variable;
        }
    }

}
