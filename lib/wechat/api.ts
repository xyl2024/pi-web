/**
 * iLink Bot CGI client — minimal HTTP wrapper used by the pi-web demo.
 *
 * Mirrors the request shape used by the openclaw-weixin plugin:
 *   POST ilink/bot/<endpoint>   application/json
 *   Authorization: Bearer <token>
 *   AuthorizationType: ilink_bot_token
 *   X-WECHAT-UIN: <base64(random uint32)>
 *   iLink-App-Id, iLink-App-ClientVersion
 *
 * QR flow endpoints hit a fixed base URL (ilinkai.weixin.qq.com); runtime
 * message endpoints use the account-specific baseUrl returned at login.
 */
import { createHash, randomBytes } from "crypto";
import { readFileSync } from "fs";
import { createLogger } from "@/lib/logger";
import type {
  BaseInfo,
  GetConfigResp,
  GetUpdatesResp,
  NotifyResp,
  QrCodeResponse,
  QrStatusResponse,
  SendMessageReq,
  SendMessageResp,
} from "./types";

const log = createLogger("wechat/api");

const FIXED_QR_BASE = "https://ilinkai.weixin.qq.com";
const ILINK_APP_ID = "bot";
const PLUGIN_VERSION = "pi-web-demo/0.1.0";

/** Read version from package.json (best effort). */
function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version?: string };
    return pkg.version ? `pi-web/${pkg.version}` : PLUGIN_VERSION;
  } catch {
    return PLUGIN_VERSION;
  }
}

function baseInfo(): BaseInfo {
  return {
    channel_version: readVersion(),
    bot_agent: "pi-web-demo",
  };
}

/** X-WECHAT-UIN header: random uint32 -> decimal string -> base64. */
function randomWechatUin(): string {
  const n = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(n), "utf8").toString("base64");
}

function commonHeaders(): Record<string, string> {
  return {
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": "65537", // 0x00010001 — any reasonable uint32
    "X-WECHAT-UIN": randomWechatUin(),
  };
}

function postHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    ...commonHeaders(),
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

function getHeaders(): Record<string, string> {
  return {
    AuthorizationType: "ilink_bot_token",
    ...commonHeaders(),
  };
}

async function postJson<T>(baseUrl: string, endpoint: string, body: unknown, token?: string): Promise<T> {
  const url = `${baseUrl.replace(/\/$/, "")}/${endpoint}`;
  const res = await fetch(url, {
    method: "POST",
    headers: postHeaders(token),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    log.warn("post non-2xx", { url, status: res.status, body: text.slice(0, 200) });
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    log.error("post bad json", { url, body: text.slice(0, 200) });
    throw err;
  }
}

async function postJsonWithTimeout<T>(baseUrl: string, endpoint: string, body: unknown, token: string | undefined, timeoutMs: number): Promise<T> {
  const url = `${baseUrl.replace(/\/$/, "")}/${endpoint}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: postHeaders(token),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      log.warn("post non-2xx", { url, status: res.status, body: text.slice(0, 200) });
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return JSON.parse(text) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function getJson<T>(baseUrl: string, endpoint: string): Promise<T> {
  const url = `${baseUrl.replace(/\/$/, "")}/${endpoint}`;
  const res = await fetch(url, { method: "GET", headers: getHeaders() });
  const text = await res.text();
  if (!res.ok) {
    log.warn("get non-2xx", { url, status: res.status, body: text.slice(0, 200) });
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    log.error("get bad json", { url, body: text.slice(0, 200) });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// QR login flow (fixed base URL)
// ---------------------------------------------------------------------------

export async function fetchQrCode(botType: string): Promise<QrCodeResponse> {
  return postJson<QrCodeResponse>(
    FIXED_QR_BASE,
    `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    { base_info: baseInfo() },
  );
}

export async function pollQrStatus(baseUrl: string, qrcode: string, verifyCode?: string): Promise<QrStatusResponse> {
  let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
  try {
    return await getJson<QrStatusResponse>(baseUrl, endpoint);
  } catch (err) {
    // Long-poll timeout or transient gateway error — treat as "still waiting"
    log.debug("pollQrStatus error (treated as wait)", { error: String(err) });
    return { status: "wait" };
  }
}

// ---------------------------------------------------------------------------
// Runtime message endpoints (account-specific baseUrl)
// ---------------------------------------------------------------------------

export async function sendTextMessage(params: {
  baseUrl: string;
  token: string;
  to: string;
  text: string;
  contextToken?: string;
  clientId: string;
}): Promise<SendMessageResp> {
  const req: SendMessageReq = {
    msg: {
      from_user_id: "",
      to_user_id: params.to,
      client_id: params.clientId,
      message_type: 2, // BOT
      message_state: 2, // FINISH
      item_list: params.text ? [{ type: 1, text_item: { text: params.text } }] : [],
      context_token: params.contextToken,
    },
  };
  return postJson<SendMessageResp>(params.baseUrl, "ilink/bot/sendmessage", { ...req, base_info: baseInfo() }, params.token);
}

export async function getConfig(params: { baseUrl: string; token: string; ilinkUserId: string; contextToken?: string }): Promise<GetConfigResp> {
  return postJson<GetConfigResp>(
    params.baseUrl,
    "ilink/bot/getconfig",
    {
      ilink_user_id: params.ilinkUserId,
      context_token: params.contextToken,
      base_info: baseInfo(),
    },
    params.token,
  );
}

export async function notifyStart(params: { baseUrl: string; token: string }): Promise<NotifyResp> {
  return postJson<NotifyResp>(params.baseUrl, "ilink/bot/msg/notifystart", { base_info: baseInfo() }, params.token);
}

export async function notifyStop(params: { baseUrl: string; token: string }): Promise<NotifyResp> {
  return postJson<NotifyResp>(params.baseUrl, "ilink/bot/msg/notifystop", { base_info: baseInfo() }, params.token);
}

const GET_UPDATES_DEFAULT_TIMEOUT_MS = 35_000;

/**
 * Long-poll for new inbound messages. Server holds the request up to ~35s.
 * Returns immediately on new messages, or on client-side timeout with the
 * empty result `{ ret: 0, msgs: [], get_updates_buf: prev }`.
 *
 * For the demo we don't actually use long-poll semantics — callers pass
 * a short timeoutMs to get fast polling behavior. The function still
 * honors long timeouts.
 */
export async function getUpdates(params: {
  baseUrl: string;
  token: string;
  getUpdatesBuf: string;
  timeoutMs?: number;
}): Promise<GetUpdatesResp> {
  const timeout = params.timeoutMs ?? GET_UPDATES_DEFAULT_TIMEOUT_MS;
  try {
    return await postJsonWithTimeout<GetUpdatesResp>(
      params.baseUrl,
      "ilink/bot/getupdates",
      {
        get_updates_buf: params.getUpdatesBuf ?? "",
        base_info: baseInfo(),
      },
      params.token,
      timeout,
    );
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      // Client-side timeout: return an empty success response so the caller
      // can keep polling with the same cursor.
      return { ret: 0, msgs: [], get_updates_buf: params.getUpdatesBuf };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

/** Generate a short clientId for outbound messages. */
export function newClientId(): string {
  return createHash("sha1").update(`${Date.now()}-${randomBytes(8).toString("hex")}`).digest("hex").slice(0, 16);
}
