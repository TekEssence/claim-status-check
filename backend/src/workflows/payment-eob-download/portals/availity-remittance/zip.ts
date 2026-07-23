import fs from "node:fs/promises";
import path from "node:path";

type ZipEntry = {
  name: string;
  content: Buffer;
  modifiedAt: Date;
};

function writeUint16(buffer: Buffer, offset: number, value: number): void {
  buffer.writeUInt16LE(value & 0xffff, offset);
}

function writeUint32(buffer: Buffer, offset: number, value: number): void {
  buffer.writeUInt32LE(value >>> 0, offset);
}

function dosDateTime(date: Date): { zipDate: number; zipTime: number } {
  const year = Math.max(date.getFullYear(), 1980);
  return {
    zipDate: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    zipTime: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
  };
}

function makeCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
}

const CRC32_TABLE = makeCrc32Table();

function crc32(content: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of content) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function collectFiles(root: string, current = ""): Promise<ZipEntry[]> {
  const entries = await fs.readdir(path.join(root, current), { withFileTypes: true });
  const files: ZipEntry[] = [];

  for (const entry of entries) {
    const relativePath = current ? `${current}/${entry.name}` : entry.name;
    const absolutePath = path.join(root, relativePath);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(root, relativePath));
    } else if (entry.isFile()) {
      const stats = await fs.stat(absolutePath);
      files.push({
        name: relativePath.replace(/\\/g, "/"),
        content: await fs.readFile(absolutePath),
        modifiedAt: stats.mtime,
      });
    }
  }

  return files;
}

export async function createStoredZipFromFolder(root: string, zipRootName: string): Promise<Buffer> {
  const entries = await collectFiles(root);
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const filename = Buffer.from(`${zipRootName}/${entry.name}`, "utf8");
    const checksum = crc32(entry.content);
    const { zipDate, zipTime } = dosDateTime(entry.modifiedAt);

    const localHeader = Buffer.alloc(30);
    writeUint32(localHeader, 0, 0x04034b50);
    writeUint16(localHeader, 4, 20);
    writeUint16(localHeader, 6, 0x0800);
    writeUint16(localHeader, 8, 0);
    writeUint16(localHeader, 10, zipTime);
    writeUint16(localHeader, 12, zipDate);
    writeUint32(localHeader, 14, checksum);
    writeUint32(localHeader, 18, entry.content.length);
    writeUint32(localHeader, 22, entry.content.length);
    writeUint16(localHeader, 26, filename.length);
    writeUint16(localHeader, 28, 0);
    localParts.push(localHeader, filename, entry.content);

    const centralHeader = Buffer.alloc(46);
    writeUint32(centralHeader, 0, 0x02014b50);
    writeUint16(centralHeader, 4, 20);
    writeUint16(centralHeader, 6, 20);
    writeUint16(centralHeader, 8, 0x0800);
    writeUint16(centralHeader, 10, 0);
    writeUint16(centralHeader, 12, zipTime);
    writeUint16(centralHeader, 14, zipDate);
    writeUint32(centralHeader, 16, checksum);
    writeUint32(centralHeader, 20, entry.content.length);
    writeUint32(centralHeader, 24, entry.content.length);
    writeUint16(centralHeader, 28, filename.length);
    writeUint16(centralHeader, 30, 0);
    writeUint16(centralHeader, 32, 0);
    writeUint16(centralHeader, 34, 0);
    writeUint16(centralHeader, 36, 0);
    writeUint32(centralHeader, 38, 0);
    writeUint32(centralHeader, 42, offset);
    centralParts.push(centralHeader, filename);

    offset += localHeader.length + filename.length + entry.content.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  writeUint32(end, 0, 0x06054b50);
  writeUint16(end, 4, 0);
  writeUint16(end, 6, 0);
  writeUint16(end, 8, entries.length);
  writeUint16(end, 10, entries.length);
  writeUint32(end, 12, centralDirectory.length);
  writeUint32(end, 16, offset);
  writeUint16(end, 20, 0);

  return Buffer.concat([...localParts, centralDirectory, end]);
}
