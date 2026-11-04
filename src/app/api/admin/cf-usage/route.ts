import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { isPrimaryAdmin } from "@/lib/auth/admin";

// PATCH 8 (fork): live Workers AI usage from Cloudflare's official analytics
// API. The app's own usage log cannot see the account-level free allocation,
// so this route queries the aiInferenceAdaptiveGroups GraphQL dataset with a
// scoped, read-only token (CF_ANALYTICS_TOKEN) and reports today's Neurons
// against the 10,000/day free allocation (resets 00:00 UTC).
const DAILY_FREE_NEURONS = 10_000;

type CfModelUsage = { modelId: string; neurons: number; inputTokens: number; outputTokens: number };

export async function GET(request: Request) {
	const env = getEnv();
	const session = await requireSessionUser(env, request);
	if (session.error) return session.error;
	if (!isPrimaryAdmin(session.user)) return Response.json({ error: "Forbidden" }, { status: 403 });
	const token = env.CF_ANALYTICS_TOKEN?.trim();
	const accountId = env.CF_ACCOUNT_ID?.trim();
	if (!token || !accountId || !/^[a-f0-9]{32}$/.test(accountId)) {
		return Response.json({ configured: false }, { headers: { "Cache-Control": "no-store" } });
	}
	const date = new Date().toISOString().slice(0, 10);
	const query = `query { viewer { accounts(filter: { accountTag: "${accountId}" }) { aiInferenceAdaptiveGroups(limit: 100, filter: { date: "${date}" }) { dimensions { modelId } sum { totalNeurons totalInputTokens totalOutputTokens } } } } }`;
	try {
		const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ query }),
			signal: AbortSignal.timeout(15_000),
		});
		if (!response.ok) {
			return Response.json({ configured: true, error: `Cloudflare API ${response.status}` }, { status: 502, headers: { "Cache-Control": "no-store" } });
		}
		const payload = (await response.json()) as {
			data?: { viewer?: { accounts?: { aiInferenceAdaptiveGroups?: { dimensions: { modelId: string }; sum: { totalNeurons: number; totalInputTokens: number; totalOutputTokens: number } }[] }[] } };
		};
		const groups = payload.data?.viewer?.accounts?.[0]?.aiInferenceAdaptiveGroups;
		if (!groups) {
			return Response.json({ configured: true, error: "Cloudflare API returned no data" }, { status: 502, headers: { "Cache-Control": "no-store" } });
		}
		const models: CfModelUsage[] = groups
			.map((group) => ({ modelId: group.dimensions.modelId, neurons: group.sum.totalNeurons, inputTokens: group.sum.totalInputTokens, outputTokens: group.sum.totalOutputTokens }))
			.sort((a, b) => b.neurons - a.neurons);
		const usedNeurons = models.reduce((total, model) => total + model.neurons, 0);
		return Response.json(
			{ configured: true, date, usedNeurons, freeNeurons: DAILY_FREE_NEURONS, remainingNeurons: Math.max(0, DAILY_FREE_NEURONS - usedNeurons), models, fetchedAt: new Date().toISOString() },
			{ headers: { "Cache-Control": "no-store" } },
		);
	} catch {
		return Response.json({ configured: true, error: "Cloudflare API unreachable" }, { status: 502, headers: { "Cache-Control": "no-store" } });
	}
}
