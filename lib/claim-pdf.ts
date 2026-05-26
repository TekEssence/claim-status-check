import zlib from "node:zlib";

/**
 * Extracts raw text content from a PDF Buffer by decompressing FlateDecode streams
 * and parsing standard PDF text operators (parenthesized strings and hex strings).
 * 
 * Works without any third-party dependencies.
 */
export function extractTextFromPdf(pdfBuffer: Buffer): string {
  let text = "";
  let pos = 0;

  while (pos < pdfBuffer.length) {
    // Find the next stream block
    const streamIndex = pdfBuffer.indexOf("stream", pos);
    if (streamIndex === -1) break;

    // Check if the stream is FlateDecode compressed
    // The dictionary preceding the stream contains the filter type
    const dictEnd = pdfBuffer.lastIndexOf(">>", streamIndex);
    const dictStart = pdfBuffer.lastIndexOf("<<", dictEnd);

    let isFlate = false;
    if (dictStart !== -1 && dictEnd !== -1 && dictStart < dictEnd) {
      const dictContent = pdfBuffer.toString("ascii", dictStart, dictEnd);
      if (dictContent.includes("/FlateDecode") || dictContent.includes("/Flate")) {
        isFlate = true;
      }
    }

    // Determine the start of the compressed stream data (skip "stream\r\n" or "stream\n")
    let dataStart = streamIndex + 6;
    if (pdfBuffer[dataStart] === 13) dataStart++; // \r
    if (pdfBuffer[dataStart] === 10) dataStart++; // \n

    const endstreamIndex = pdfBuffer.indexOf("endstream", dataStart);
    if (endstreamIndex === -1) {
      pos = dataStart;
      continue;
    }

    let dataEnd = endstreamIndex;
    // Strip trailing newlines before "endstream" if present
    if (pdfBuffer[dataEnd - 1] === 10) dataEnd--;
    if (pdfBuffer[dataEnd - 1] === 13) dataEnd--;

    const streamData = pdfBuffer.subarray(dataStart, dataEnd);
    pos = endstreamIndex + 9;

    if (isFlate) {
      try {
        // Decompress the stream using zlib
        const decompressed = zlib.inflateSync(streamData);
        const decompressedStr = decompressed.toString("binary");
        
        let i = 0;
        let lineBuffer = "";
        while (i < decompressedStr.length) {
          const char = decompressedStr[i];
          if (char === "(") {
            // Read parenthesized string
            let j = i + 1;
            let depth = 1;
            const strChars: string[] = [];
            while (j < decompressedStr.length && depth > 0) {
              const c = decompressedStr[j];
              if (c === "(") {
                depth++;
                strChars.push(c);
              } else if (c === ")") {
                depth--;
                if (depth > 0) strChars.push(c);
              } else if (c === "\\") {
                const next = decompressedStr[j + 1];
                if (next === "(" || next === ")" || next === "\\") {
                  strChars.push(next);
                  j++;
                } else if (next === "n") {
                  strChars.push("\n");
                  j++;
                } else if (next === "r") {
                  strChars.push("\r");
                  j++;
                } else if (next === "t") {
                  strChars.push("\t");
                  j++;
                } else {
                  strChars.push(c);
                }
              } else {
                strChars.push(c);
              }
              j++;
            }
            lineBuffer += strChars.join("");
            i = j;
          } else if (char === "<") {
            // Read hex string
            let j = i + 1;
            const hexChars: string[] = [];
            while (j < decompressedStr.length && decompressedStr[j] !== ">") {
              hexChars.push(decompressedStr[j]);
              j++;
            }
            const hexStr = hexChars.join("").trim();
            if (/^[0-9a-fA-F]+$/.test(hexStr)) {
              let decoded = "";
              for (let k = 0; k < hexStr.length; k += 2) {
                const code = parseInt(hexStr.substring(k, k + 2), 16);
                if (code >= 32 && code <= 126) {
                  decoded += String.fromCharCode(code);
                }
              }
              lineBuffer += decoded;
            }
            i = j + 1;
          } else if (decompressedStr.substring(i, i + 2) === "T*" || char === "\n") {
            // Newline markers in PDF text streams
            text += lineBuffer + "\n";
            lineBuffer = "";
            i += char === "\n" ? 1 : 2;
          } else {
            i++;
          }
        }
        if (lineBuffer) {
          text += lineBuffer + "\n";
        }
      } catch (e) {
        // Skip streams that fail decompression
      }
    }
  }

  return text;
}
