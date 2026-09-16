// Verilog keywords shared by Verilog and SystemVerilog documents.
export const VERILOG_KEYWORDS: readonly string[] = `
    always and assign automatic begin buf bufif0 bufif1 case casex casez cell
    cmos config deassign default defparam design disable edge else end endcase
    endconfig endfunction endgenerate endmodule endprimitive endspecify endtable
    endtask event for force forever fork function generate genvar highz0 highz1
    if ifnone incdir include initial inout input instance integer join large
    liblist library localparam macromodule medium module nand negedge nmos nor
    noshowcancelled not notif0 notif1 or output parameter pmos posedge primitive
    pull0 pull1 pulldown pullup pulsestyle_onevent pulsestyle_ondetect rcmos real
    realtime reg release repeat rnmos rpmos rtran rtranif0 rtranif1 scalared
    showcancelled signed small specify specparam strong0 strong1 supply0 supply1
    table task time tran tranif0 tranif1 tri tri0 tri1 triand trior trireg
    unsigned use uwire vectored wait wand weak0 weak1 while wire wor xnor xor
`.trim().split(/\s+/);

// SystemVerilog adds these keywords to the Verilog keyword set.
export const SYSTEMVERILOG_KEYWORDS: readonly string[] = [
    ...VERILOG_KEYWORDS,
    ...`
        accept_on alias always_comb always_ff always_latch assert assume before
        bind bins binsof bit break byte chandle checker class clocking const
        constraint context continue cover covergroup coverpoint cross dist do
        endchecker endclass endclocking endgroup endinterface endpackage
        endprogram endproperty endsequence enum eventually expect export extends extern
        final first_match foreach forkjoin global iff ignore_bins illegal_bins
        implements implies import inside int interconnect interface intersect
        join_any join_none let local logic longint matches modport nettype new
        nexttime null package packed priority program property protected pure
        rand randc randcase randsequence ref reject_on restrict return s_always
        s_eventually s_nexttime s_until s_until_with sequence shortint shortreal
        soft solve static string strong struct super sync_accept_on
        sync_reject_on tagged this throughout timeprecision timeunit type
        typedef union unique unique0 until until_with untyped var virtual void
        wait_order weak wildcard with within
    `.trim().split(/\s+/)
];

export function getKeywords(languageId: string): readonly string[] {
    switch (languageId) {
        case 'verilog': return VERILOG_KEYWORDS;
        case 'systemverilog': return SYSTEMVERILOG_KEYWORDS;
        default: return [];
    }
}
