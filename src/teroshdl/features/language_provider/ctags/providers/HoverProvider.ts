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

// import * as vscode from 'vscode';
import { HoverProvider, TextDocument, Position, CancellationToken, Hover, window, Range, MarkdownString } from 'vscode';
import { Ctags, CtagsManager, Symbol } from '../ctags';
import { Logger, Log_Severity } from '../Logger';
import { FileSymbolCache } from '../../index/fileCache';
import { getCompletionScopes, getVisibleCompletionSymbols } from './completionScopes';

export default class VerilogHoverProvider implements HoverProvider {
    // lang: verilog / systemverilog
    private logger: Logger;

    constructor(logger: Logger, private cache: FileSymbolCache = CtagsManager.fileCache) {
        this.logger = logger;
    }

    public provideHover(document: TextDocument, position: Position, token: CancellationToken): Hover | undefined | Promise<Hover | undefined> {
        this.logger.log("Hover requested");
        // get word start and end
        let textRange = document.getWordRangeAtPosition(position);
        if (textRange === undefined || textRange.isEmpty) {
            return;
        }
        // hover word
        let targetText = document.getText(textRange);
        if (this.cache && document.uri.scheme === 'file') {
            const version = document.version;
            return this.cache.get(document.uri.fsPath).then(snapshot => {
                if (token?.isCancellationRequested || version !== document.version) { return; }
                const symbols = ['verilog', 'systemverilog'].includes(document.languageId) ?
                    getVisibleCompletionSymbols(snapshot.symbols, getCompletionScopes(document.getText()), document.offsetAt(position)) : snapshot.symbols;
                const symbol = symbols.find(symbol => document.languageId === 'vhdl' ?
                    symbol.name.toUpperCase() === targetText.toUpperCase() : symbol.name === targetText);
                if (!symbol) { return; }
                const hoverText = new MarkdownString();
                hoverText.appendCodeblock(snapshot.source.split('\n')[symbol.startPosition.line]?.trim() ?? '', document.languageId);
                return new Hover(hoverText);
            }).catch(error => { this.logger.log(`Hover indexing failed: ${error}`, Log_Severity.Error); return undefined; });
        }
        let ctags: Ctags = CtagsManager.ctags;
        if (ctags.doc === undefined || ctags.doc.uri.toString() !== document.uri.toString()) { // systemverilog keywords
            return;
        }
        else {
            // find symbol
            for (let i of ctags.symbols) {
                // returns the first found tag. Disregards others
                // TODO: very basic hover implementation. Can be extended


                //VHDL is case insensitive
                if (document.languageId === "vhdl") {
                    if (i.name.toUpperCase() === targetText.toUpperCase()) {
                        let codeRange = new Range(i.startPosition, new Position(i.startPosition.line, Number.MAX_VALUE));
                        let code = document.getText(codeRange).trim();
                        let hoverText: MarkdownString = new MarkdownString();
                        hoverText.appendCodeblock(code, document.languageId);
                        this.logger.log("Hover object returned");
                        return new Hover(hoverText);
                    }
                }
                //Verilog is case sensitive
                else if (document.languageId === "verilog" || document.languageId === "systemverilog") {
                    if (i.name === targetText) {
                        let codeRange = new Range(i.startPosition, new Position(i.startPosition.line, Number.MAX_VALUE));
                        let code = document.getText(codeRange).trim();
                        let hoverText: MarkdownString = new MarkdownString();
                        hoverText.appendCodeblock(code, document.languageId);
                        this.logger.log("Hover object returned");
                        return new Hover(hoverText);
                    }
                }
                //TCL is case sensitive
                else if (document.languageId === "tcl") {
                    if (i.name === targetText) {
                        let codeRange = new Range(i.startPosition, new Position(i.startPosition.line, Number.MAX_VALUE));
                        let code = document.getText(codeRange).trim();
                        let hoverText: MarkdownString = new MarkdownString();
                        hoverText.appendCodeblock(code, document.languageId);
                        this.logger.log("Hover object returned");
                        return new Hover(hoverText);
                    }
                }
            }
            this.logger.log("Hover object not found", Log_Severity.Warn);
            return;
        }
    }
}
