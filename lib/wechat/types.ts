/**
 * iLink Bot CGI protocol types — minimal subset for the pi-web demo.
 * Mirrors the structure used by openclaw-weixin but trimmed to what
 * the demo actually needs.
 */

/** Attached to every outgoing CGI request. */
export interface BaseInfo {
  channel_version: string;
  bot_agent: string;
}

/** QR login: get_bot_qrcode response. */
export interface QrCodeResponse {
  qrcode: string;             // opaque token used to poll get_qrcode_status
  qrcode_img_content: string; // the actual weixin://… URL to render
}

/** QR login: get_qrcode_status response. */
export type QrStatus =
  | "wait"
  | "scaned"
  | "need_verifycode"
  | "verify_code_blocked"
  | "scaned_but_redirect"
  | "expired"
  | "confirmed"
  | "binded_redirect";

export interface QrStatusResponse {
  status: QrStatus;
  bot_token?: string;
  ilink_bot_id?: string;     // account id
  baseurl?: string;          // may differ from default on IDC redirect
  ilink_user_id?: string;    // the human who scanned
  redirect_host?: string;
}

/** sendmessage request body. */
export interface SendMessageReq {
  msg: {
    from_user_id: string;
    to_user_id: string;
    client_id: string;
    message_type: number;     // 1=USER 2=BOT
    message_state: number;    // 0=NEW 1=GENERATING 2=FINISH
    item_list?: Array<{
      type: number;            // 1=TEXT
      text_item?: { text: string };
    }>;
    context_token?: string;
  };
}

/** sendmessage response (empty on success). */
export interface SendMessageResp {
  ret?: number;
  errmsg?: string;
}

/** getconfig response (typing ticket). */
export interface GetConfigResp {
  ret?: number;
  errmsg?: string;
  typing_ticket?: string;
}

/** getupdates response. */
export interface GetUpdatesResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  /** Sync cursor — send back as `get_updates_buf` on next call. */
  get_updates_buf?: string;
  /** Server-suggested timeout for next call (ms). */
  longpolling_timeout_ms?: number;
}

/** Minimal shape of a WeixinMessage — only fields the demo needs. */
export interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  create_time_ms?: number;
  message_type?: number;
  message_state?: number;
  item_list?: Array<{
    type?: number;            // 1=TEXT 2=IMAGE 3=VOICE 4=FILE 5=VIDEO
    text_item?: { text?: string };
    image_item?: unknown;
    voice_item?: unknown;
    file_item?: unknown;
    video_item?: unknown;
  }>;
  context_token?: string;
}

/** A known contact (someone who messaged the bot at least once). */
export interface WeChatContact {
  userId: string;             // xxx@im.wechat
  firstSeen: string;          // ISO timestamp
  lastSeen: string;           // ISO timestamp
  messageCount: number;
  lastMessagePreview: string; // up to ~80 chars
  /** Cached context_token from the most recent inbound — drop into sendMessage for context. */
  contextToken?: string;
}

/** notifystart / notifystop response. */
export interface NotifyResp {
  ret?: number;
  errmsg?: string;
}

/** Persisted account credentials. */
export interface WeChatAccount {
  accountId: string;
  token: string;
  baseUrl: string;
  userId?: string;
  savedAt: string;
  /**
   * Currently active workspace (absolute cwd). Set via the workspace
   * dropdown in WeChatPanel. Switching workspace clears currentSessionId
   * (L2 cold-start semantics — next inbound message spawns a new session).
   */
  currentWorkspaceId?: string;
  /**
   * Currently active session within the current workspace. null/undefined
   * means "no session yet — next inbound message will cold-start a new one".
   */
  currentSessionId?: string;
  /**
   * "ok" by default. Set to "expired" when an outbound request fails with
   * 401 / token-expired — the panel reads this to surface a re-scan banner.
   */
  status?: "ok" | "expired";
}

/** Per-login session state (in-memory only). */
export type LoginPhase =
  | "waiting"        // QR shown, waiting for scan
  | "scanned"        // scanned, processing
  | "verifying"      // need verify code from user
  | "verify_blocked" // too many wrong codes, refresh
  | "redirected"     // scanning on a different IDC, switched host
  | "confirmed"      // confirmed, credentials saved
  | "already_bound"  // this OpenClaw already bound to scanned bot
  | "expired"        // QR expired
  | "error";

export interface LoginSession {
  sessionKey: string;
  qrcodeUrl: string;
  qrcode: string;
  baseUrl: string;          // current effective host (may switch on redirect)
  botType: string;
  startedAt: number;
  phase: LoginPhase;
  pendingVerifyCode?: string;
  message?: string;
  account?: WeChatAccount;
}
