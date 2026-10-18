/**
 * Native EmDash email provider backed by Resend's HTTP API.
 *
 * Registers the exclusive `email:deliver` hook so it becomes the site's active
 * email provider. The API key and sender identity are configured in the admin
 * (Settings -> Plugins) and the key is stored encrypted by EmDash.
 */
import { definePlugin } from "emdash";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

async function readConfig(ctx) {
	const [apiKey, from, fromName, replyTo] = await Promise.all([
		ctx.settings.get("apiKey"),
		ctx.settings.get("from"),
		ctx.settings.get("fromName"),
		ctx.settings.get("replyTo"),
	]);
	return {
		apiKey: typeof apiKey === "string" ? apiKey.trim() : "",
		from: typeof from === "string" ? from.trim() : "",
		fromName: typeof fromName === "string" ? fromName.trim() : "",
		replyTo: typeof replyTo === "string" ? replyTo.trim() : "",
	};
}

export function createPlugin() {
	return definePlugin({
		id: "dominium-resend-email",
		version: "1.0.0",
		capabilities: ["network:request", "email:provide"],
		allowedHosts: ["api.resend.com"],
		admin: {
			settingsSchema: {
				apiKey: {
					type: "secret",
					label: "Resend API key",
					description: "Create one at resend.com/api-keys. Stored encrypted by EmDash.",
				},
				from: {
					type: "email",
					label: "From address",
					placeholder: "no-reply@yourdomain.com",
					description: "Must belong to a domain verified in Resend.",
				},
				fromName: {
					type: "string",
					label: "From name",
					default: "Dominium Tecnologia",
				},
				replyTo: {
					type: "email",
					label: "Reply-To address (optional)",
				},
			},
		},
		hooks: {
			"email:deliver": {
				exclusive: true,
				priority: 50,
				errorPolicy: "abort",
				handler: async (event, ctx) => {
					const config = await readConfig(ctx);
					if (!config.apiKey) {
						throw new Error(
							"Resend email provider: no API key configured (Settings -> Plugins -> Resend Email).",
						);
					}
					if (!config.from) {
						throw new Error(
							"Resend email provider: no From address configured (Settings -> Plugins -> Resend Email).",
						);
					}

					const { message } = event;
					const replyTo = message.replyTo || config.replyTo || undefined;
					const payload = {
						from: config.fromName ? `${config.fromName} <${config.from}>` : config.from,
						to: [message.to],
						subject: message.subject,
						text: message.text,
						...(message.html ? { html: message.html } : {}),
						...(Array.isArray(message.cc) && message.cc.length > 0
							? { cc: message.cc }
							: {}),
						...(replyTo ? { reply_to: replyTo } : {}),
					};

					const response = await ctx.http.fetch(RESEND_ENDPOINT, {
						method: "POST",
						headers: {
							authorization: `Bearer ${config.apiKey}`,
							"content-type": "application/json",
						},
						body: JSON.stringify(payload),
					});

					if (!response.ok) {
						const detail = await response.text().catch(() => "");
						throw new Error(
							`Resend delivery failed (${response.status}): ${detail.slice(0, 300)}`,
						);
					}

					ctx.log.info("Email delivered via Resend", {
						to: message.to,
						subject: message.subject,
						source: event.source,
					});
				},
			},
		},
	});
}
