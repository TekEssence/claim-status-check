"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
var fs_1 = __importDefault(require("fs"));
var claim_pdf_1 = require("../lib/claim-pdf");
var buf = fs_1.default.readFileSync('7_40000018584200_02-09-2026 (3).pdf');
var txt = (0, claim_pdf_1.extractTextFromPdf)(buf);
var lines = txt.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
var matchingLine = "";
var memberPolicyId = '40000018584200';
var dosStr = '02/09/2026';
for (var j = 0; j < lines.length; j++) {
    if (lines[j].includes(memberPolicyId)) {
        // Collect until we see another 14-digit member ID or hit 50 lines
        var end = j + 1;
        while (end < lines.length && end - j < 50) {
            if (/^\d{14}$/.test(lines[end]))
                break; // another member id
            end++;
        }
        var block = lines.slice(j, end);
        if (block.some(function (l) { return l.includes(dosStr); })) {
            matchingLine = block.join(" ");
            break;
        }
    }
}
console.log('Result:', matchingLine);
