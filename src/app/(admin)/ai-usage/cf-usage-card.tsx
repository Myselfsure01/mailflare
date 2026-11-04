"use client";

// PATCH 8 (fork): live Cloudflare Workers AI usage card. Data comes from
// /api/admin/cf-usage, which queries Cloudflare's official analytics API
// server-side; nothing renders when the scoped token is not configured.
import { useCallback, useEffect, useState } from "react";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { authFetch } from "@/lib/auth/client";

type CfUsage = {
	configured: boolean;
	error?: string;
	usedNeurons?: number;
	freeNeurons?: number;
	remainingNeurons?: number;
	models?: { modelId: string; neurons: number; inputTokens: number; outputTokens: number }[];
	fetchedAt?: string;
};

function formatNeurons(value: number) {
	return value.toLocaleString(undefined, { maximumFractionDigits: value < 100 ? 1 : 0 });
}

export function CfUsageCard() {
	const { t } = useLanguage();
	const [data, setData] = useState<CfUsage | null>(null);
	const [failed, setFailed] = useState(false);
	const [refreshing, setRefreshing] = useState(false);

	const load = useCallback(async () => {
		setRefreshing(true);
		try {
			const response = await authFetch("/api/admin/cf-usage");
			const payload = (await response.json()) as CfUsage;
			if (!response.ok && !payload.configured) throw new Error("load failed");
			setData(payload);
			setFailed(!!payload.error);
		} catch {
			setFailed(true);
		} finally {
			setRefreshing(false);
		}
	}, []);

	useEffect(() => { void load(); }, [load]);

	if (data && !data.configured) return null;

	const used = data?.usedNeurons ?? 0;
	const free = data?.freeNeurons ?? 10_000;
	const percent = Math.min(100, (used / free) * 100);

	return (
		<section className="rounded-2xl bg-white p-5">
			<div className="flex items-start justify-between gap-4">
				<div>
					<h2 className="text-sm font-medium text-neutral-900">{t("aiUsage.cf.title")}</h2>
					<p className="mt-1 text-xs text-neutral-500">{t("aiUsage.cf.note")}</p>
				</div>
				<Button type="button" variant="outline" size="sm" disabled={refreshing} onClick={() => void load()}>{t("aiUsage.cf.refresh")}</Button>
			</div>
			{failed && <p role="alert" className="mt-3 text-sm text-red-700">{t("aiUsage.cf.loadFailed")}</p>}
			{!data && !failed && <p className="mt-3 text-sm text-neutral-500">{t("aiUsage.loading")}</p>}
			{data && !data.error && (
				<>
					<div className="mt-4 flex flex-wrap items-baseline gap-x-6 gap-y-2">
						<p className="text-2xl font-semibold text-neutral-900">{formatNeurons(used)} <span className="text-sm font-normal text-neutral-500">/ {formatNeurons(free)} Neurons</span></p>
						<p className="text-sm text-neutral-600">{t("aiUsage.cf.remaining")}: {formatNeurons(data.remainingNeurons ?? 0)}</p>
						<p className="text-sm text-neutral-600">{percent.toFixed(1)}%</p>
						{data.fetchedAt && <p className="text-xs text-neutral-400">{t("aiUsage.cf.updated", { time: new Date(data.fetchedAt).toLocaleTimeString() })}</p>}
					</div>
					<div className="mt-3 h-2 overflow-hidden rounded-full bg-neutral-100"><div className="h-full rounded-full bg-blue-600" style={{ width: `${percent}%` }} /></div>
					{data.models && data.models.length > 0 && (
						<ul className="mt-4 divide-y divide-neutral-100 text-sm">
							{data.models.map((model) => (
								<li key={model.modelId} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
									<span className="break-all text-neutral-700">{model.modelId}</span>
									<span className="tabular-nums text-neutral-600">{formatNeurons(model.neurons)} Neurons · {t("aiUsage.cf.tokens", { input: model.inputTokens.toLocaleString(), output: model.outputTokens.toLocaleString() })}</span>
								</li>
							))}
						</ul>
					)}
				</>
			)}
		</section>
	);
}
