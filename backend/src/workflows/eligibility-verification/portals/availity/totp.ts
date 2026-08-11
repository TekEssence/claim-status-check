import crypto from "node:crypto";

type ProtobufField = {
  fieldNumber: number;
  wireType: number;
  value: bigint | Buffer;
};

type GoogleAuthenticatorAccount = {
  secret: Buffer;
  algorithm: number;
  digits: number;
  type: number;
  issuer: string;
  name: string;
};

function readVarint(buffer: Buffer, startOffset: number): { value: bigint; offset: number } {
  let result = BigInt(0);
  let shift = BigInt(0);
  let offset = startOffset;

  while (offset < buffer.length) {
    const byte = buffer[offset];
    offset += 1;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value: result, offset };
    }
    shift += BigInt(7);
  }

  throw new Error("Invalid Google Authenticator migration data: unterminated varint.");
}

function readFields(buffer: Buffer): ProtobufField[] {
  const fields: ProtobufField[] = [];
  let offset = 0;

  while (offset < buffer.length) {
    const key = readVarint(buffer, offset);
    offset = key.offset;

    const fieldNumber = Number(key.value >> BigInt(3));
    const wireType = Number(key.value & BigInt(7));

    if (wireType === 0) {
      const value = readVarint(buffer, offset);
      fields.push({ fieldNumber, wireType, value: value.value });
      offset = value.offset;
    } else if (wireType === 2) {
      const length = readVarint(buffer, offset);
      offset = length.offset;
      const endOffset = offset + Number(length.value);
      fields.push({ fieldNumber, wireType, value: buffer.subarray(offset, endOffset) });
      offset = endOffset;
    } else {
      throw new Error(`Unsupported Google Authenticator migration wire type: ${wireType}.`);
    }
  }

  return fields;
}

function decodeMigrationData(dataValue: string): GoogleAuthenticatorAccount[] {
  const decoded = decodeURIComponent(dataValue.trim());
  const padded = decoded + "=".repeat((4 - (decoded.length % 4)) % 4);
  const payload = Buffer.from(padded, "base64");

  return readFields(payload)
    .filter((field) => field.fieldNumber === 1 && Buffer.isBuffer(field.value))
    .map((field) => {
      const account: GoogleAuthenticatorAccount = {
        secret: Buffer.alloc(0),
        algorithm: 1,
        digits: 1,
        type: 2,
        issuer: "",
        name: "",
      };

      for (const nestedField of readFields(field.value as Buffer)) {
        if (nestedField.fieldNumber === 1 && Buffer.isBuffer(nestedField.value)) {
          account.secret = nestedField.value;
        } else if (nestedField.fieldNumber === 2 && Buffer.isBuffer(nestedField.value)) {
          account.name = nestedField.value.toString("utf8");
        } else if (nestedField.fieldNumber === 3 && Buffer.isBuffer(nestedField.value)) {
          account.issuer = nestedField.value.toString("utf8");
        } else if (nestedField.fieldNumber === 4 && typeof nestedField.value === "bigint") {
          account.algorithm = Number(nestedField.value);
        } else if (nestedField.fieldNumber === 5 && typeof nestedField.value === "bigint") {
          account.digits = Number(nestedField.value);
        } else if (nestedField.fieldNumber === 6 && typeof nestedField.value === "bigint") {
          account.type = Number(nestedField.value);
        }
      }

      return account;
    })
    .filter((account) => account.secret.length > 0 && account.type === 2);
}

function digestForAlgorithm(algorithm: number): string {
  if (algorithm === 2) return "sha256";
  if (algorithm === 3) return "sha512";
  if (algorithm === 4) return "md5";
  return "sha1";
}

function digitCount(digits: number): number {
  return digits === 2 ? 8 : 6;
}

function generateTotp(secret: Buffer, options: { digits: number; algorithm: string; timestamp?: number }): string {
  const counter = Math.floor((options.timestamp ?? Date.now()) / 1000 / 30);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));

  const hmac = crypto.createHmac(options.algorithm, secret).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return String(code % 10 ** options.digits).padStart(options.digits, "0");
}

export function generateAvailityEligibilityTotp(dataValue: string, timeOffsetSeconds = 0): string {
  if (!dataValue.trim()) {
    throw new Error("Availity Google Authenticator DATA_VALUE is empty. Check the Secret Key column.");
  }

  const [account] = decodeMigrationData(dataValue);
  if (!account) {
    throw new Error("Availity Google Authenticator migration data did not contain a TOTP account.");
  }

  return generateTotp(account.secret, {
    algorithm: digestForAlgorithm(account.algorithm),
    digits: digitCount(account.digits),
    timestamp: Date.now() + (timeOffsetSeconds * 1000),
  });
}