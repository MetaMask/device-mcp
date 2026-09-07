// Implemented from the public AOSP APK Signature Scheme v2/v3 spec.
/**
 * Pure-JS verifier for APK Signature Scheme v2 and v3.
 *
 * This proves an APK was cryptographically SIGNED by a given key — it verifies
 * the signature over the recomputed APK content digest, then binds the leaf
 * certificate to that key. It is NOT a cert-presence check: reading a
 * certificate out of an APK proves nothing (certificates are public), so this
 * module recomputes the content digest and verifies the signature before
 * trusting the signer. Used to gate `am instrument` against a helper that could
 * otherwise be a package-name squatter.
 *
 * No external dependencies, no Android SDK, no shelling out — `node:crypto` and
 * `node:fs` only, so it runs on any consumer machine that runs the MCP server.
 */

import {
  createHash,
  createPublicKey,
  verify as cryptoVerify,
  X509Certificate,
} from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { SnapshotHelperError, UntrustedHelperError } from './errors.js';

export type ApkSignerVerification = {
  verified: true;
  signerSha256: string;
  scheme: 'v2' | 'v3';
};

const MAX_APK_BYTES = 200 * 1024 * 1024;

const EOCD_SIGNATURE = 0x0605_4b50;
const EOCD_MIN_SIZE = 22;
const EOCD_CD_OFFSET_FIELD = 16;
const EOCD_COMMENT_LENGTH_FIELD = 20;

const SIG_BLOCK_MAGIC = Buffer.from('APK Sig Block 42', 'latin1');
const SIG_BLOCK_FOOTER_SIZE = 24;

const V2_BLOCK_ID = 0x7109_871a;
const V3_BLOCK_ID = 0xf053_68c0;

const CHUNK_SIZE = 1024 * 1024;
const CHUNK_PREFIX = 0xa5;
const TOP_LEVEL_PREFIX = 0x5a;

type ContentDigestAlgo = 'sha256' | 'sha512';

type SigAlgo = {
  hash: ContentDigestAlgo;
  verify: (
    data: Buffer,
    key: ReturnType<typeof createPublicKey>,
    signature: Buffer,
  ) => boolean;
  strength: number;
};

const RSA_PKCS1_PSS_PADDING = 6;

/**
 * Map an APK signature-algorithm ID to its hash and verification strategy.
 * IDs and their crypto meanings are fixed by the AOSP spec.
 *
 * @param id - The 32-bit signature algorithm identifier.
 * @returns The algorithm descriptor, or null when unsupported (e.g. fs-verity).
 */
function sigAlgo(id: number): SigAlgo | null {
  switch (id) {
    case 0x0101:
      return {
        hash: 'sha256',
        strength: 1,
        verify: (data, key, signature) =>
          cryptoVerify(
            'sha256',
            data,
            { key, padding: RSA_PKCS1_PSS_PADDING, saltLength: 32 },
            signature,
          ),
      };
    case 0x0102:
      return {
        hash: 'sha512',
        strength: 3,
        verify: (data, key, signature) =>
          cryptoVerify(
            'sha512',
            data,
            { key, padding: RSA_PKCS1_PSS_PADDING, saltLength: 64 },
            signature,
          ),
      };
    case 0x0103:
      return {
        hash: 'sha256',
        strength: 0,
        verify: (data, key, signature) =>
          cryptoVerify('sha256', data, key, signature),
      };
    case 0x0104:
      return {
        hash: 'sha512',
        strength: 2,
        verify: (data, key, signature) =>
          cryptoVerify('sha512', data, key, signature),
      };
    case 0x0201:
      return {
        hash: 'sha256',
        strength: 1,
        verify: (data, key, signature) =>
          cryptoVerify('sha256', data, key, signature),
      };
    case 0x0202:
      return {
        hash: 'sha512',
        strength: 3,
        verify: (data, key, signature) =>
          cryptoVerify('sha512', data, key, signature),
      };
    case 0x0301:
      return {
        hash: 'sha256',
        strength: 1,
        verify: (data, key, signature) =>
          cryptoVerify('sha256', data, key, signature),
      };
    default:
      return null;
  }
}

/**
 * Raise an {@link SnapshotHelperError} for any malformed or unverifiable APK.
 *
 * @param message - What went wrong.
 * @throws Always.
 */
function invalid(message: string): never {
  throw new SnapshotHelperError('ARTIFACT_INVALID', message);
}

/**
 * Find the ZIP End Of Central Directory record by scanning backwards.
 *
 * @param apk - The whole APK file.
 * @returns The EOCD start offset plus the central-directory offset and size it
 * declares.
 */
function findEocd(apk: Buffer): {
  eocdOffset: number;
  centralDirOffset: number;
  centralDirSize: number;
} {
  const minStart = Math.max(0, apk.length - EOCD_MIN_SIZE - 0xffff);
  for (let i = apk.length - EOCD_MIN_SIZE; i >= minStart; i -= 1) {
    if (apk.readUInt32LE(i) !== EOCD_SIGNATURE) {
      continue;
    }
    const commentLength = apk.readUInt16LE(i + EOCD_COMMENT_LENGTH_FIELD);
    if (i + EOCD_MIN_SIZE + commentLength !== apk.length) {
      continue;
    }
    return {
      eocdOffset: i,
      centralDirOffset: apk.readUInt32LE(i + EOCD_CD_OFFSET_FIELD),
      centralDirSize: apk.readUInt32LE(i + 12),
    };
  }
  return invalid('APK is missing a ZIP End Of Central Directory record');
}

/**
 * Locate the APK Signing Block that sits immediately before the central
 * directory.
 *
 * @param apk - The whole APK file.
 * @param centralDirOffset - The central-directory offset from the EOCD.
 * @param eocdOffset - The EOCD start offset.
 * @param centralDirSize - The central-directory size from the EOCD.
 * @returns The signing-block offset and its payload (between the two size
 * fields, excluding the trailing size and magic).
 */
function findSigningBlock(
  apk: Buffer,
  centralDirOffset: number,
  eocdOffset: number,
  centralDirSize: number,
): { apkSigBlockOffset: number; pairs: Buffer } {
  if (centralDirOffset + centralDirSize !== eocdOffset) {
    invalid('Central directory is not immediately followed by the EOCD');
  }
  if (centralDirOffset < SIG_BLOCK_FOOTER_SIZE) {
    invalid('No APK Signing Block before the central directory');
  }
  const footer = apk.subarray(
    centralDirOffset - SIG_BLOCK_FOOTER_SIZE,
    centralDirOffset,
  );
  if (!footer.subarray(8, 24).equals(SIG_BLOCK_MAGIC)) {
    invalid('APK Signing Block magic not found (APK is not v2/v3 signed)');
  }
  const trailerSize = footer.readBigUInt64LE(0);
  const totalSize = Number(trailerSize) + 8;
  const apkSigBlockOffset = centralDirOffset - totalSize;
  if (apkSigBlockOffset < 0) {
    invalid('APK Signing Block size is out of range');
  }
  const headerSize = apk.readBigUInt64LE(apkSigBlockOffset);
  if (headerSize !== trailerSize) {
    invalid('APK Signing Block header/footer size mismatch');
  }
  const pairs = apk.subarray(
    apkSigBlockOffset + 8,
    centralDirOffset - SIG_BLOCK_FOOTER_SIZE,
  );
  return { apkSigBlockOffset, pairs };
}

/**
 * Extract a scheme block (v2 or v3) from the signing block's ID/value pairs.
 *
 * @param pairs - The concatenated ID/value pairs.
 * @returns The v3 block if present, else the v2 block, with its scheme label.
 */
function selectSchemeBlock(pairs: Buffer): {
  scheme: 'v2' | 'v3';
  block: Buffer;
} {
  const blocks = new Map<number, Buffer>();
  let cursor = 0;
  while (cursor + 8 <= pairs.length) {
    const pairSize = Number(pairs.readBigUInt64LE(cursor));
    cursor += 8;
    if (pairSize < 4 || cursor + pairSize > pairs.length) {
      break;
    }
    const id = pairs.readUInt32LE(cursor);
    const value = pairs.subarray(cursor + 4, cursor + pairSize);
    blocks.set(id, value);
    cursor += pairSize;
  }
  const v3 = blocks.get(V3_BLOCK_ID);
  if (v3) {
    return { scheme: 'v3', block: v3 };
  }
  const v2 = blocks.get(V2_BLOCK_ID);
  if (v2) {
    return { scheme: 'v2', block: v2 };
  }
  return invalid('No v2 or v3 signature block in the APK Signing Block');
}

/**
 * Read a `uint32`-length-prefixed slice, advancing the cursor past it.
 *
 * @param bytes - The buffer to read from.
 * @param cursor - The current read offset.
 * @returns The inner bytes and the offset just past them.
 */
function readLenPrefixed(
  bytes: Buffer,
  cursor: number,
): { value: Buffer; next: number } {
  if (cursor + 4 > bytes.length) {
    invalid('Truncated length-prefixed field');
  }
  const len = bytes.readUInt32LE(cursor);
  const start = cursor + 4;
  const end = start + len;
  if (end > bytes.length) {
    invalid('Length-prefixed field runs past end of block');
  }
  return { value: bytes.subarray(start, end), next: end };
}

/**
 * Split a length-prefixed sequence into its length-prefixed elements.
 *
 * @param seq - The sequence bytes (already unwrapped from its own prefix).
 * @returns The element buffers in order.
 */
function readSequence(seq: Buffer): Buffer[] {
  const items: Buffer[] = [];
  let cursor = 0;
  while (cursor < seq.length) {
    const { value, next } = readLenPrefixed(seq, cursor);
    items.push(value);
    cursor = next;
  }
  return items;
}

type SignedDataElement = { algoId: number; payload: Buffer };

/**
 * Parse the `{ uint32 algoId; len-prefixed payload }` records used by both the
 * signed-data digests list and the signatures list.
 *
 * @param seq - The sequence bytes.
 * @returns The parsed algorithm-id/payload records in order.
 */
function readAlgoRecords(seq: Buffer): SignedDataElement[] {
  return readSequence(seq).map((element) => {
    if (element.length < 4) {
      invalid('Algorithm record too short');
    }
    return {
      algoId: element.readUInt32LE(0),
      payload: readLenPrefixed(element, 4).value,
    };
  });
}

type ParsedSigner = {
  signedData: Buffer;
  digests: SignedDataElement[];
  certificates: Buffer[];
  signatures: SignedDataElement[];
  publicKey: Buffer;
  signedMinSdk?: number;
  signedMaxSdk?: number;
  signerMinSdk?: number;
  signerMaxSdk?: number;
};

/**
 * Parse a single signer out of a v2/v3 scheme block.
 *
 * @param block - The scheme block value (a length-prefixed signers sequence).
 * @param scheme - Which scheme is being parsed (v3 carries extra SDK fields).
 * @returns The parsed signer.
 */
function parseSigner(block: Buffer, scheme: 'v2' | 'v3'): ParsedSigner {
  const signers = readSequence(readLenPrefixed(block, 0).value);
  if (signers.length !== 1) {
    invalid(`Expected exactly one signer, found ${signers.length}`);
  }
  const signer = signers[0];

  let cursor = 0;
  const signedDataRead = readLenPrefixed(signer, cursor);
  const signedData = signedDataRead.value;
  cursor = signedDataRead.next;

  let signerMinSdk: number | undefined;
  let signerMaxSdk: number | undefined;
  if (scheme === 'v3') {
    if (cursor + 8 > signer.length) {
      invalid('v3 signer missing min/max SDK');
    }
    signerMinSdk = signer.readUInt32LE(cursor);
    signerMaxSdk = signer.readUInt32LE(cursor + 4);
    cursor += 8;
  }

  const signaturesRead = readLenPrefixed(signer, cursor);
  cursor = signaturesRead.next;

  const publicKeyRead = readLenPrefixed(signer, cursor);

  let sdCursor = 0;
  const digestsRead = readLenPrefixed(signedData, sdCursor);
  sdCursor = digestsRead.next;
  const certificatesRead = readLenPrefixed(signedData, sdCursor);
  sdCursor = certificatesRead.next;

  let signedMinSdk: number | undefined;
  let signedMaxSdk: number | undefined;
  if (scheme === 'v3') {
    if (sdCursor + 8 > signedData.length) {
      invalid('v3 signed-data missing min/max SDK');
    }
    signedMinSdk = signedData.readUInt32LE(sdCursor);
    signedMaxSdk = signedData.readUInt32LE(sdCursor + 4);
  }

  return {
    signedData,
    digests: readAlgoRecords(digestsRead.value),
    certificates: readSequence(certificatesRead.value),
    signatures: readAlgoRecords(signaturesRead.value),
    publicKey: publicKeyRead.value,
    signedMinSdk,
    signedMaxSdk,
    signerMinSdk,
    signerMaxSdk,
  };
}

/**
 * Compute the chunked content digest of one segment, appending each chunk's
 * digest to `out`.
 *
 * @param segment - The segment bytes.
 * @param hash - The digest algorithm.
 * @param out - Accumulator for per-chunk digests.
 * @returns The number of chunks produced.
 */
function digestSegment(
  segment: Buffer,
  hash: ContentDigestAlgo,
  out: Buffer[],
): number {
  let chunks = 0;
  for (let offset = 0; offset < segment.length; offset += CHUNK_SIZE) {
    const chunk = segment.subarray(offset, offset + CHUNK_SIZE);
    const prefix = Buffer.allocUnsafe(5);
    prefix.writeUInt8(CHUNK_PREFIX, 0);
    prefix.writeUInt32LE(chunk.length, 1);
    out.push(createHash(hash).update(prefix).update(chunk).digest());
    chunks += 1;
  }
  return chunks;
}

/**
 * Recompute the APK content digest per the v2/v3 spec: chunk the pre-signing
 * bytes, the central directory, and the EOCD (patched so its central-directory
 * offset points at the signing block), then hash the concatenated chunk
 * digests.
 *
 * @param apk - The whole APK file.
 * @param apkSigBlockOffset - Offset of the APK Signing Block.
 * @param centralDirOffset - Central-directory offset.
 * @param eocdOffset - EOCD start offset.
 * @param hash - The content-digest algorithm.
 * @returns The recomputed content digest.
 */
function computeContentDigest(
  apk: Buffer,
  apkSigBlockOffset: number,
  centralDirOffset: number,
  eocdOffset: number,
  hash: ContentDigestAlgo,
): Buffer {
  const beforeBlock = apk.subarray(0, apkSigBlockOffset);
  const centralDir = apk.subarray(centralDirOffset, eocdOffset);
  const eocd = Buffer.from(apk.subarray(eocdOffset));
  eocd.writeUInt32LE(apkSigBlockOffset, EOCD_CD_OFFSET_FIELD);

  const chunkDigests: Buffer[] = [];
  let count = 0;
  count += digestSegment(beforeBlock, hash, chunkDigests);
  count += digestSegment(centralDir, hash, chunkDigests);
  count += digestSegment(eocd, hash, chunkDigests);

  const top = createHash(hash);
  const header = Buffer.allocUnsafe(5);
  header.writeUInt8(TOP_LEVEL_PREFIX, 0);
  header.writeUInt32LE(count, 1);
  top.update(header);
  for (const digest of chunkDigests) {
    top.update(digest);
  }
  return top.digest();
}

/**
 * Verify an APK's v2/v3 signature and return its leaf signer certificate
 * SHA-256.
 *
 * @param apkPath - Path to the APK on disk.
 * @returns The verified scheme and lowercase-hex leaf certificate SHA-256.
 * @throws {@link SnapshotHelperError} when the APK is malformed or the
 * signature does not verify.
 */
export async function verifyApkSignerSha256(
  apkPath: string,
): Promise<ApkSignerVerification> {
  const apk = await readFile(apkPath);
  if (apk.length > MAX_APK_BYTES) {
    invalid(`APK exceeds ${MAX_APK_BYTES} bytes`);
  }

  const { eocdOffset, centralDirOffset, centralDirSize } = findEocd(apk);
  const { apkSigBlockOffset, pairs } = findSigningBlock(
    apk,
    centralDirOffset,
    eocdOffset,
    centralDirSize,
  );
  const { scheme, block } = selectSchemeBlock(pairs);
  const signer = parseSigner(block, scheme);

  if (signer.certificates.length < 1) {
    invalid('Signer has no certificates');
  }

  const selected = signer.signatures
    .map((signature) => ({ signature, algo: sigAlgo(signature.algoId) }))
    .filter(
      (entry): entry is { signature: SignedDataElement; algo: SigAlgo } =>
        entry.algo !== null,
    )
    .sort((a, b) => b.algo.strength - a.algo.strength)
    .at(0);
  if (!selected) {
    invalid('No supported signature algorithm in signer');
  }

  const publicKey = createPublicKey({
    key: signer.publicKey,
    format: 'der',
    type: 'spki',
  });
  if (
    !selected.algo.verify(
      signer.signedData,
      publicKey,
      selected.signature.payload,
    )
  ) {
    invalid('Signature did not verify over signed-data');
  }

  const leaf = signer.certificates[0];
  const certPublicKey = new X509Certificate(leaf).publicKey;
  const certSpki = certPublicKey.export({ format: 'der', type: 'spki' });
  if (!certSpki.equals(signer.publicKey)) {
    invalid('Leaf certificate public key does not match the block public key');
  }

  const sigIds = signer.signatures.map((s) => s.algoId);
  const digestIds = signer.digests.map((d) => d.algoId);
  if (
    sigIds.length !== digestIds.length ||
    sigIds.some((id, index) => id !== digestIds[index])
  ) {
    invalid('Signature and digest algorithm lists differ');
  }

  const expectedDigest = signer.digests.find(
    (d) => d.algoId === selected.signature.algoId,
  );
  if (!expectedDigest) {
    invalid('No content digest for the selected algorithm');
  }
  const computed = computeContentDigest(
    apk,
    apkSigBlockOffset,
    centralDirOffset,
    eocdOffset,
    selected.algo.hash,
  );
  if (!computed.equals(expectedDigest.payload)) {
    invalid('Recomputed APK content digest does not match signed digest');
  }

  if (scheme === 'v3') {
    if (
      signer.signerMinSdk !== signer.signedMinSdk ||
      signer.signerMaxSdk !== signer.signedMaxSdk
    ) {
      invalid('v3 signer min/max SDK does not match signed-data');
    }
  }

  const signerSha256 = createHash('sha256').update(leaf).digest('hex');
  return { verified: true, signerSha256, scheme };
}

/**
 * Verify an APK and assert its signer matches an expected pinned SHA-256.
 *
 * @param apkPath - Path to the APK on disk.
 * @param expectedSignerSha256 - The pinned lowercase-hex signer SHA-256.
 * @throws {@link UntrustedHelperError} when the (validly signed) APK's signer
 * does not match the pin.
 * @throws {@link SnapshotHelperError} when the APK is malformed or unverifiable.
 */
export async function assertApkSignerSha256(
  apkPath: string,
  expectedSignerSha256: string,
): Promise<void> {
  const { signerSha256 } = await verifyApkSignerSha256(apkPath);
  const expected = expectedSignerSha256.toLowerCase();
  if (signerSha256 !== expected) {
    throw new UntrustedHelperError(
      'Installed snapshot helper is signed by an unexpected certificate',
      { expectedSignerSha256: expected, actualSignerSha256: signerSha256 },
    );
  }
}
