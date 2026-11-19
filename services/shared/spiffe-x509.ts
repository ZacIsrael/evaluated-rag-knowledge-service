/*
Prepare SPIRE-issued certificates, private keys, and trust bundles for Node TLS.
Pass along replacement certificates when SPIRE rotates a workload identity.
*/

import { X509Certificate } from "node:crypto";
import { SpiffeClient } from "@jeengbe/spiffe";

// Keep private keys in memory; never log or write this material to disk.
export type X509TlsMaterial = {
  cert: string;
  key: string;
  ca: string[];
};

// SPIRE supplies DER-encoded certificates. Convert each complete
// certificate in a concatenated chain into PEM for Node TLS.
function certificatesToPem(der: Uint8Array): string[] {
  // A SPIRE response can contain multiple DER certificates concatenated
  // together. Collect each one separately for Node's TLS configuration.
  const certificates: string[] = [];
  let offset = 0;

  while (offset < der.length) {
    // Every DER certificate starts with an ASN.1 SEQUENCE (0x30), followed
    // by bytes describing its length. Ensure those bytes are present.
    if (der[offset] !== 0x30 || offset + 2 > der.length) {
      throw new Error("Invalid DER certificate sequence");
    }

    // The first length byte either contains the content length directly
    // or tells us how many subsequent bytes encode that length.
    const lengthByte = der[offset + 1]!;
    let headerLength = 2;
    let contentLength = lengthByte;

    if (lengthByte & 0x80) {
      // With the high bit set, the remaining seven bits give the number
      // of length bytes. DER does not permit an indefinite length here.
      const lengthBytes = lengthByte & 0x7f;

      if (
        lengthBytes === 0 ||
        lengthBytes > 4 ||
        offset + 2 + lengthBytes > der.length
      ) {
        throw new Error("Invalid DER certificate length");
      }

      headerLength += lengthBytes;
      contentLength = 0;

      // Read the multi-byte length in big-endian order.
      for (let index = 0; index < lengthBytes; index++) {
        contentLength = contentLength * 256 + der[offset + 2 + index]!;
      }
    }

    // The header and content together identify exactly where this
    // certificate ends and the next certificate may begin.
    const end = offset + headerLength + contentLength;

    if (end > der.length || contentLength === 0) {
      throw new Error("Truncated DER certificate");
    }

    // PEM is the same certificate encoded as base64 between delimiters.
    // Wrap the base64 at 64 characters per line for standard PEM formatting.
    const base64 = Buffer.from(der.subarray(offset, end)).toString("base64");
    const pem =
      `-----BEGIN CERTIFICATE-----\n` +
      `${base64.match(/.{1,64}/g)?.join("\n")}\n` +
      `-----END CERTIFICATE-----\n`;

    // Confirm Node can parse the certificate before using it for TLS.
    new X509Certificate(pem);
    certificates.push(pem);

    // Continue at the first byte after this certificate.
    offset = end;
  }

  // An empty chain cannot establish a TLS identity or trust bundle.
  if (certificates.length === 0) {
    throw new Error("SPIRE returned an empty certificate chain");
  }

  return certificates;
}

// SPIRE supplies the private key as DER-encoded PKCS#8 bytes.
function keyToPem(der: Uint8Array): string {
  // SPIRE supplies the private key as DER-encoded PKCS#8 bytes.
  // An empty key cannot be used to establish the workload's TLS identity.
  if (der.length === 0) {
    throw new Error("SPIRE returned an empty private key");
  }

  // PEM represents those same bytes as base64 text; this conversion
  // does not change or decrypt the private key.
  const base64 = Buffer.from(der).toString("base64");

  // Wrap the base64 in PKCS#8 PEM delimiters so Node TLS can read it.
  // Keep the result in memory rather than writing the key to a file.
  return (
    `-----BEGIN PRIVATE KEY-----\n` +
    `${base64.match(/.{1,64}/g)?.join("\n")}\n` +
    `-----END PRIVATE KEY-----\n`
  );
}

// Subscribe to identity updates so the TLS server can use rotated SVIDs.
export async function* watchX509TlsMaterial(
  spiffe: SpiffeClient,
  expectedSpiffeId: string
): AsyncGenerator<X509TlsMaterial> {
  // Subscribe to the SPIRE Workload API. It sends the current identity
  // material and subsequent updates when certificates rotate.
  for await (const update of spiffe.api.fetchX509SVID({})) {
    // Select the SVID registered for this workload. Do not accidentally
    // serve another identity if SPIRE returns more than one.
    const svid = update.svids.find(
      (entry) => entry.spiffeId === expectedSpiffeId
    );

    // Stop rather than continuing with an unexpected or missing identity.
    if (!svid) {
      throw new Error(`No X.509-SVID for ${expectedSpiffeId}`);
    }

    // Convert SPIRE's DER bytes into the PEM values Node TLS expects:
    // the workload's certificate chain, its private key, and trusted CAs.
    yield {
      cert: certificatesToPem(svid.x509Svid).join(""),
      key: keyToPem(svid.x509SvidKey),
      ca: certificatesToPem(svid.bundle),
    };

    // The consumer applies this material to its TLS server, then waits
    // here for the next SPIRE update.
  }
}
