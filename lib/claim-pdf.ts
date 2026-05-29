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
  
  interface TextChunk {
    text: string;
    x: number;
    y: number;
  }
  const allChunks: TextChunk[] = [];

  while (pos < pdfBuffer.length) {
    const streamIndex = pdfBuffer.indexOf("stream", pos);
    if (streamIndex === -1) break;

    const dictEnd = pdfBuffer.lastIndexOf(">>", streamIndex);
    const dictStart = pdfBuffer.lastIndexOf("<<", dictEnd);

    let isFlate = false;
    if (dictStart !== -1 && dictEnd !== -1 && dictStart < dictEnd) {
      const dictContent = pdfBuffer.toString("ascii", dictStart, dictEnd);
      if (dictContent.includes("/FlateDecode") || dictContent.includes("/Flate")) {
        isFlate = true;
      }
    }

    let dataStart = streamIndex + 6;
    if (pdfBuffer[dataStart] === 13) dataStart++;
    if (pdfBuffer[dataStart] === 10) dataStart++;

    const endstreamIndex = pdfBuffer.indexOf("endstream", dataStart);
    if (endstreamIndex === -1) {
      pos = dataStart;
      continue;
    }

    let dataEnd = endstreamIndex;
    if (pdfBuffer[dataEnd - 1] === 10) dataEnd--;
    if (pdfBuffer[dataEnd - 1] === 13) dataEnd--;

    const streamData = pdfBuffer.subarray(dataStart, dataEnd);
    pos = endstreamIndex + 9;

    if (isFlate) {
      try {
        const decompressed = zlib.inflateSync(streamData);
        const decompressedStr = decompressed.toString("binary");
        
        let currentX = 0;
        let currentY = 0;
        
        // Tokenize stream to grab operators
        // A simple regex approach to find operators like Tm, Td, Tj
        const tokenRegex = /(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+Tm|(-?[\d.]+)\s+(-?[\d.]+)\s+Td|(-?[\d.]+)\s+(-?[\d.]+)\s+TD|<([0-9a-fA-F]+)>\s*Tj|\((.*?)(?<!\\)\)\s*Tj/g;
        
        let match;
        // Due to the complexity of nested parentheses in regex, we still do the manual loop for strings
        // But let's build a simpler state machine
        
        let i = 0;
        let lineBuffer = "";
        
        while (i < decompressedStr.length) {
          const char = decompressedStr[i];
          
          if (char === "(") {
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
                } else if (next === "n") { strChars.push("\n"); j++; }
                else if (next === "r") { strChars.push("\r"); j++; }
                else if (next === "t") { strChars.push("\t"); j++; }
                else { strChars.push(c); }
              } else {
                strChars.push(c);
              }
              j++;
            }
            const parsedStr = strChars.join("");
            allChunks.push({ text: parsedStr, x: currentX, y: currentY });
            currentX += parsedStr.length * 5; // pseudo advance
            i = j;
          } else if (char === "<") {
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
              allChunks.push({ text: decoded, x: currentX, y: currentY });
              currentX += decoded.length * 5; // pseudo advance
            }
            i = j + 1;
          } else if (decompressedStr.startsWith("Tm", i) || decompressedStr.startsWith("Td", i)) {
            // Find preceding numbers
            const lookBack = decompressedStr.substring(Math.max(0, i - 50), i);
            const matches = [...lookBack.matchAll(/(-?[\d.]+)/g)];
            if (decompressedStr.startsWith("Tm", i) && matches.length >= 6) {
              const tx = parseFloat(matches[matches.length - 2][1]);
              const ty = parseFloat(matches[matches.length - 1][1]);
              currentX = tx;
              currentY = ty;
            } else if (decompressedStr.startsWith("Td", i) && matches.length >= 2) {
              const tx = parseFloat(matches[matches.length - 2][1]);
              const ty = parseFloat(matches[matches.length - 1][1]);
              currentX += tx;
              currentY += ty;
            }
            i += 2;
          } else {
            i++;
          }
        }
      } catch (e) {}
    }
  }

  // Sort chunks vertically (top to bottom -> higher Y means higher on page in PDF)
  // PDF Y axis is bottom-to-top, so sort Y descending. 
  // Then sort X horizontally (left to right -> sort X ascending).
  // Allow a small threshold for Y to group words on the same visual line.
  allChunks.sort((a, b) => {
    const yDiff = Math.abs(a.y - b.y);
    if (yDiff > 5) {
      return b.y - a.y; 
    }
    return a.x - b.x;
  });

  // Group into lines
  const lines: string[] = [];
  let currentLineText = "";
  let lastY = -9999;
  
  for (const chunk of allChunks) {
    if (Math.abs(chunk.y - lastY) > 5) {
      if (currentLineText) lines.push(currentLineText.trim());
      currentLineText = chunk.text;
      lastY = chunk.y;
    } else {
      currentLineText += " " + chunk.text;
    }
  }
  if (currentLineText) lines.push(currentLineText.trim());

  return lines.join("\n");
}
