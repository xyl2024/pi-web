import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Provider } from "@earendil-works/pi-ai";

export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;
  const runtime = await ModelRuntime.create();
  const oauthProvider = runtime.getProviders().find((p: Provider) => p.id === provider && p.auth.oauth);
  if (!oauthProvider) {
    return Response.json({ error: `Unknown provider: ${provider}` }, { status: 400 });
  }
  await runtime.logout(provider);
  return Response.json({ ok: true });
}
