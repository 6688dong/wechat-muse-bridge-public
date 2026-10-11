import { encryptAesEcb } from "./aes-ecb.js";
import { buildCdnUploadUrl } from "./cdn-url.js";
import { logger } from "../util/logger.js";
import { redactUrl } from "../util/redact.js";

/** Maximum retry attempts for CDN upload. */
const UPLOAD_MAX_RETRIES = 5;
/**
 * Backoff delays (ms) before retry attempts 2..5.
 * The WeChat CDN intermittently returns 500 in clusters lasting minutes;
 * immediate retries all fail, so wait progressively longer between attempts.
 */
const UPLOAD_RETRY_DELAYS_MS = [5000, 15000, 30000, 60000];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Upload one buffer to the Weixin CDN with AES-128-ECB encryption.
 * Returns the download encrypted_query_param from the CDN response.
 * Retries up to UPLOAD_MAX_RETRIES times on server errors; client errors (4xx) abort immediately.
 */
export async function uploadBufferToCdn(params: {
  buf: Buffer;
  /** From getUploadUrl.upload_full_url; POST target when set (takes precedence over uploadParam). */
  uploadFullUrl?: string;
  uploadParam?: string;
  filekey: string;
  cdnBaseUrl: string;
  label: string;
  aeskey: Buffer;
}): Promise<{ downloadParam: string }> {
  const { buf, uploadFullUrl, uploadParam, filekey, cdnBaseUrl, label, aeskey } = params;
  const ciphertext = encryptAesEcb(buf, aeskey);
  const trimmedFull = uploadFullUrl?.trim();
  let cdnUrl: string;
  if (trimmedFull) {
    cdnUrl = trimmedFull;
  } else if (uploadParam) {
    cdnUrl = buildCdnUploadUrl({ cdnBaseUrl, uploadParam, filekey });
  } else {
    throw new Error(`${label}: CDN upload URL missing (need upload_full_url or upload_param)`);
  }
  logger.debug(`${label}: CDN POST url=${redactUrl(cdnUrl)} ciphertextSize=${ciphertext.length}`);

  let downloadParam: string | undefined;
  let lastError: unknown;

  for (let attempt = 1; attempt <= UPLOAD_MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(cdnUrl, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(ciphertext),
      });
      if (res.status >= 400 && res.status < 500) {
        const errMsg = res.headers.get("x-error-message") ?? (await res.text());
        logger.error(
          `${label}: CDN client error attempt=${attempt} status=${res.status} errMsg=${errMsg}`,
        );
        throw new Error(`CDN upload client error ${res.status}: ${errMsg}`);
      }
      if (res.status !== 200) {
        const errMsg = res.headers.get("x-error-message") ?? `status ${res.status}`;
        logger.error(
          `${label}: CDN server error attempt=${attempt} status=${res.status} errMsg=${errMsg}`,
        );
        throw new Error(`CDN upload server error: ${errMsg}`);
      }
      downloadParam = res.headers.get("x-encrypted-param") ?? undefined;
      if (!downloadParam) {
        logger.error(
          `${label}: CDN response missing x-encrypted-param header attempt=${attempt}`,
        );
        throw new Error("CDN upload response missing x-encrypted-param header");
      }
      logger.debug(`${label}: CDN upload success attempt=${attempt}`);
      break;
    } catch (err) {
      lastError = err;
      if (err instanceof Error && err.message.includes("client error")) throw err;
      if (attempt < UPLOAD_MAX_RETRIES) {
        const delay = UPLOAD_RETRY_DELAYS_MS[attempt - 1] ?? 60000;
        logger.error(
          `${label}: attempt ${attempt} failed, retrying in ${delay}ms... err=${String(err)}`,
        );
        await sleep(delay);
      } else {
        logger.error(`${label}: all ${UPLOAD_MAX_RETRIES} attempts failed err=${String(err)}`);
      }
    }
  }

  if (!downloadParam) {
    throw lastError instanceof Error
      ? lastError
      : new Error(`CDN upload failed after ${UPLOAD_MAX_RETRIES} attempts`);
  }
  return { downloadParam };
}
