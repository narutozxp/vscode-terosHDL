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
    DefinitionProvider, TextDocument, CancellationToken, Position,
    ProviderResult, DefinitionLink, Range, Uri
} from 'vscode';
import { Ctags, CtagsManager, Symbol } from '../ctags';
import { Logger } from '../Logger';
import { FileSymbolCache } from '../../index/fileCache';
import type { ProjectLanguageService } from '../../index/projectService';
import { getCompletionScopes, getVisibleCompletionSymbols } from './completionScopes';

export default class VerilogDefinitionProvider implements DefinitionProvider {

    private logger: Logger;
    constructor(logger: Logger, private cache: FileSymbolCache = CtagsManager.fileCache,
        private project?: ProjectLanguageService) {
        this.logger = logger;
    }

    async provideDefinition(document: TextDocument, position: Position,
        token: CancellationToken): Promise<DefinitionLink[]> {
        const word = document.getWordRangeAtPosition(position);
        if (!word || word.isEmpty) { return []; }
        const name = document.getText(word);
        const version = document.version;
        const verilog = ['verilog', 'systemverilog'].includes(document.languageId);
        try {
            const snapshot = this.cache && document.uri.scheme === 'file' ? await this.cache.get(document.uri.fsPath) : undefined;
            if (token?.isCancellationRequested || document.version !== version) { return []; }
            const ctags = CtagsManager.ctags;
            let symbols = snapshot?.symbols ?? (ctags?.doc?.uri.toString() === document.uri.toString() ? ctags.symbols : []);
            if (verilog) { symbols = getVisibleCompletionSymbols(symbols, getCompletionScopes(document.getText()), document.offsetAt(position)); }
            const matches = symbols.filter(symbol => document.languageId === 'vhdl' ?
                symbol.name.toUpperCase() === name.toUpperCase() : symbol.name === name);
            const definitions: DefinitionLink[] = matches.map(symbol => ({
                originSelectionRange: word,
                targetUri: document.uri,
                targetRange: new Range(symbol.startPosition, symbol.endPosition),
                targetSelectionRange: new Range(symbol.startPosition, new Position(symbol.startPosition.line, symbol.name.length))
            }));
            if (verilog && this.project && !matches.some(symbol => symbol.type !== 'module')) {
                const modules = (await this.project.modules(document)).filter(module => module.name === name);
                if (token?.isCancellationRequested || document.version !== version) { return []; }
                return modules.map(module => {
                    const line = this.cache?.peek(module.filePath)?.source.split('\n')[module.line] ?? '';
                    const column = Math.max(0, line.indexOf(module.name));
                    const selection = new Range(new Position(module.line, column), new Position(module.line, column + module.name.length));
                    return { originSelectionRange: word, targetUri: Uri.file(module.filePath),
                        targetRange: selection, targetSelectionRange: selection };
                });
            }
            return definitions;
        } catch (error) { this.logger.log(`Definition indexing failed: ${error}`); return []; }
    }

}
