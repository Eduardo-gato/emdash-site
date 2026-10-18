/**
 * Native EmDash webhook plugin.
 *
 * Posts a JSON payload to one or more webhook URLs whenever content or media
 * changes. Configuration lives in the admin (Settings -> Plugins): the URLs,
 * the event filter, and an optional HMAC signing secret.
 */
import { definePlugin } from "emdash";

const DEFAULT_EVENTS = [
	"content.saved",
	"content.published",
	"content.deleted",
	"media.uploaded",
];

function asString(value) {
	if (typeof value === "string") return value;
	if (value === null || value === undefined) return "";
	return String(value);
}

/** Split a textarea/comma value into a trimmed, non-empty list. */
function splitList(raw) {
	return asString(raw)
		.split(/[\n,]+/)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

/** HMAC-SHA256 of the body, hex-encoded. Empty string when no secret is set. */
async function sign(secret, body) {
	if (!secret) return "";
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
	return Array.from(new Uint8Array(signature))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

/** Reduce a stored entry to the fields a webhook consumer cares about. */
function summarizeEntry(collection, entry) {
	const record = entry && typeof entry === "object" ? entry : {};
	const data = record.data && typeof record.data === "object" ? record.data : {};
	return {
		collection,
		id: asString(record.id) || null,
		slug: asString(record.slug) || null,
		status: asString(record.status) || null,
		title: asString(data.title ?? record.title) || null,
		createdAt: asString(record.createdAt) || null,
		updatedAt: asString(record.updatedAt) || null,
	};
}

async function notify(ctx, eventName, payload) {
	const urls = splitList(await ctx.settings.get("urls"));
	if (urls.length === 0) return;

	const configured = splitList(await ctx.settings.get("events"));
	const events = configured.length > 0 ? configured : DEFAULT_EVENTS;
	if (!events.includes(eventName)) return;

	const secret = asString(await ctx.settings.get("secret"));
	const body = JSON.stringify({
		event: eventName,
		occurredAt: new Date().toISOString(),
		...payload,
	});
	const signature = await sign(secret, body);

	await Promise.allSettled(
		urls.map(async (url) => {
			try {
				const response = await ctx.http.fetch(url, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"user-agent": "EmDash-Webhooks/1.0",
						"x-emdash-event": eventName,
						"x-emdash-signature": signature ? `sha256=${signature}` : "none",
					},
					body,
				});
				if (!response.ok) {
					ctx.log.warn(`Webhook ${eventName} -> ${url} returned ${response.status}`);
				}
			} catch (error) {
				ctx.log.warn(
					`Webhook ${eventName} -> ${url} failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}),
	);
}

export function createPlugin() {
	return definePlugin({
		id: "dominium-webhooks",
		version: "1.0.0",
		capabilities: ["network:request"],
		// Webhook targets are chosen by the operator, so any host is allowed.
		allowedHosts: ["*"],
		admin: {
			settingsSchema: {
				urls: {
					type: "string",
					multiline: true,
					label: "Webhook URLs",
					description:
						"One URL per line. Each selected event sends a JSON POST to every URL.",
				},
				events: {
					type: "string",
					label: "Events",
					default: DEFAULT_EVENTS.join(","),
					description: `Comma-separated list. Available: ${DEFAULT_EVENTS.join(", ")}. Leave blank to send all.`,
				},
				secret: {
					type: "secret",
					label: "Signing secret (optional)",
					description:
						"When set, every request carries x-emdash-signature: sha256=<HMAC-SHA256 of the JSON body>.",
				},
			},
		},
		hooks: {
			"content:afterSave": async (event, ctx) => {
				await notify(ctx, "content.saved", {
					isNew: event.isNew,
					entry: summarizeEntry(event.collection, event.content),
				});
			},
			"content:afterPublish": async (event, ctx) => {
				await notify(ctx, "content.published", {
					entry: summarizeEntry(event.collection, event.content),
				});
			},
			"content:afterDelete": async (event, ctx) => {
				await notify(ctx, "content.deleted", {
					collection: event.collection,
					id: event.id,
					permanent: event.permanent,
				});
			},
			"media:afterUpload": async (event, ctx) => {
				await notify(ctx, "media.uploaded", {
					media: {
						id: event.media?.id ?? null,
						filename: event.media?.filename ?? null,
						mimeType: event.media?.mimeType ?? null,
						url: event.media?.url ?? null,
					},
				});
			},
		},
	});
}
