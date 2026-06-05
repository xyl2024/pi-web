/**
 * Next.js server-startup hook. Runs once per server process boot, before
 * any request is served. Used here to start the WeChat inbound monitor
 * so an existing logged-in account is handled even when no one has yet
 * loaded any pi-web page.
 *
 * Next.js picks this file up automatically (no opt-in needed in 16.x).
 *
 * We deliberately avoid importing the full `@/lib/wechat` barrel here
 * — only the startup module. This keeps the dependency surface tiny
 * and avoids any chance of pulling client-bundled code into the server
 * startup path.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { bootstrap } = await import("@/lib/wechat/startup");
    bootstrap();
  }
}
