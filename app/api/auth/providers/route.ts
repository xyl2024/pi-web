import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Provider } from "@earendil-works/pi-ai";

export const dynamic = "force-dynamic";

export async function GET() {
  const runtime = await ModelRuntime.create();
  const oauthProviders = runtime.getProviders().filter((p: Provider) => p.auth.oauth);

  const EXCLUDED = new Set(["anthropic"]);
  const DISPLAY_NAMES: Record<string, string> = {
    "openai-codex": "ChatGPT Plus/Pro",
    "github-copilot": "GitHub Copilot",
  };

  const credentials = await runtime.listCredentials();
  const configured = new Set(credentials.map((c) => c.providerId));

  const result = oauthProviders
    .filter((p: Provider) => !EXCLUDED.has(p.id))
    .map((p: Provider) => ({
      id: p.id,
      name: DISPLAY_NAMES[p.id] ?? p.name,
      usesCallbackServer: false,
      loggedIn: configured.has(p.id),
    }));

  return Response.json({ providers: result });
}
