"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractTextFromPdf = extractTextFromPdf;
var node_zlib_1 = __importDefault(require("node:zlib"));
/**
 * Extracts raw text content from a PDF Buffer by decompressing FlateDecode streams
 * and parsing standard PDF text operators (parenthesized strings and hex strings).
 *
 * Works without any third-party dependencies.
 */
function extractTextFromPdf(pdfBuffer) {
    var text = "";
    var pos = 0;
    while (pos < pdfBuffer.length) {
        // Find the next stream block
        var streamIndex = pdfBuffer.indexOf("stream", pos);
        if (streamIndex === -1)
            break;
        // Check if the stream is FlateDecode compressed
        // The dictionary preceding the stream contains the filter type
        var dictEnd = pdfBuffer.lastIndexOf(">>", streamIndex);
        var dictStart = pdfBuffer.lastIndexOf("<<", dictEnd);
        var isFlate = false;
        if (dictStart !== -1 && dictEnd !== -1 && dictStart < dictEnd) {
            var dictContent = pdfBuffer.toString("ascii", dictStart, dictEnd);
            if (dictContent.includes("/FlateDecode") || dictContent.includes("/Flate")) {
                isFlate = true;
            }
        }
        // Determine the start of the compressed stream data (skip "stream\r\n" or "stream\n")
        var dataStart = streamIndex + 6;
        if (pdfBuffer[dataStart] === 13)
            dataStart++; // \r
        if (pdfBuffer[dataStart] === 10)
            dataStart++; // \n
        var endstreamIndex = pdfBuffer.indexOf("endstream", dataStart);
        if (endstreamIndex === -1) {
            pos = dataStart;
            continue;
        }
        var dataEnd = endstreamIndex;
        // Strip trailing newlines before "endstream" if present
        if (pdfBuffer[dataEnd - 1] === 10)
            dataEnd--;
        if (pdfBuffer[dataEnd - 1] === 13)
            dataEnd--;
        var streamData = pdfBuffer.subarray(dataStart, dataEnd);
        pos = endstreamIndex + 9;
        if (isFlate) {
            try {
                // Decompress the stream using zlib
                var decompressed = node_zlib_1.default.inflateSync(streamData);
                var decompressedStr = decompressed.toString("binary");
                var i = 0;
                var lineBuffer = "";
                while (i < decompressedStr.length) {
                    var char = decompressedStr[i];
                    if (char === "(") {
                        // Read parenthesized string
                        var j = i + 1;
                        var depth = 1;
                        var strChars = [];
                        while (j < decompressedStr.length && depth > 0) {
                            var c = decompressedStr[j];
                            if (c === "(") {
                                depth++;
                                strChars.push(c);
                            }
                            else if (c === ")") {
                                depth--;
                                if (depth > 0)
                                    strChars.push(c);
                            }
                            else if (c === "\\") {
                                var next = decompressedStr[j + 1];
                                if (next === "(" || next === ")" || next === "\\") {
                                    strChars.push(next);
                                    j++;
                                }
                                else if (next === "n") {
                                    strChars.push("\n");
                                    j++;
                                }
                                else if (next === "r") {
                                    strChars.push("\r");
                                    j++;
                                }
                                else if (next === "t") {
                                    strChars.push("\t");
                                    j++;
                                }
                                else {
                                    strChars.push(c);
                                }
                            }
                            else {
                                strChars.push(c);
                            }
                            j++;
                        }
                        lineBuffer += strChars.join("");
                        i = j;
                    }
                    else if (char === "<") {
                        // Read hex string
                        var j = i + 1;
                        var hexChars = [];
                        while (j < decompressedStr.length && decompressedStr[j] !== ">") {
                            hexChars.push(decompressedStr[j]);
                            j++;
                        }
                        var hexStr = hexChars.join("").trim();
                        if (/^[0-9a-fA-F]+$/.test(hexStr)) {
                            var decoded = "";
                            for (var k = 0; k < hexStr.length; k += 2) {
                                var code = parseInt(hexStr.substring(k, k + 2), 16);
                                if (code >= 32 && code <= 126) {
                                    decoded += String.fromCharCode(code);
                                }
                            }
                            lineBuffer += decoded;
                        }
                        i = j + 1;
                    }
                    else if (decompressedStr.substring(i, i + 2) === "T*" || char === "\n") {
                        // Newline markers in PDF text streams
                        text += lineBuffer + "\n";
                        lineBuffer = "";
                        i += char === "\n" ? 1 : 2;
                    }
                    else {
                        i++;
                    }
                }
                if (lineBuffer) {
                    text += lineBuffer + "\n";
                }
            }
            catch (e) {
                // Skip streams that fail decompression
            }
        }
    }
    return text;
}
