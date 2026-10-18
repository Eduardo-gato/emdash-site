import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { d1, r2 } from "@emdash-cms/cloudflare";
import icon from "astro-iconset";
import { defineConfig, fontProviders } from "astro/config";
import emdash from "emdash/astro";
import { emprivacyPlugin } from "@emplugins/emprivacy";
import { fileURLToPath } from "node:url";

// --- Site plugins ---------------------------------------------------------
// EmPrivacy: cookie consent banner, categories, and gated scripts (native).
// Webhooks + Resend email are site-local native plugins in src/plugins; their
// module specifiers resolve through the Vite aliases configured below.
const localPlugin = (name) => fileURLToPath(new URL(`./src/plugins/${name}`, import.meta.url));

const webhooksPlugin = () => ({
	id: "dominium-webhooks",
	version: "1.0.0",
	entrypoint: "emdash-plugin-webhooks-local",
	format: "native",
});

const resendEmailPlugin = () => ({
	id: "dominium-resend-email",
	version: "1.0.0",
	entrypoint: "emdash-plugin-resend-local",
	format: "native",
});

// --- Workers compatibility patch for EmPrivacy -----------------------------
// `@emplugins/emprivacy` builds its browser copy of the "non-public host"
// SSRF check with `new Function(...)` evaluated at *module top level*. The
// Cloudflare Workers runtime forbids dynamic code generation ("Code generation
// from strings disallowed for this context"), so merely importing the package
// throws during module evaluation and takes the whole EmDash middleware down
// with it (no setup probe, no runtime/migrations, every request 404s).
//
// The generated source is static, so we inline an equivalent implementation at
// build time. Semantics are identical to the original script; it is only the
// dynamic-vs-static construction that changes.
const EMPRIVACY_EVAL_PATCH = String.raw`const hostBlockedImpl = (() => {
	function emEndsWith(h, s) { return h.length >= s.length && h.slice(h.length - s.length) === s; }
	function emParseV4(host) {
		const p = host.split(".");
		if (p.length !== 4) return null;
		let n = 0;
		for (let i = 0; i < p.length; i++) {
			const part = p[i];
			if (!/^\d{1,3}$/.test(part)) return null;
			if (part.length > 1 && part.charAt(0) === "0") return null;
			const v = +part;
			if (v > 255) return null;
			n = n * 256 + v;
		}
		return n >>> 0;
	}
	function emV4Blocked(n) {
		const a = n >>> 24;
		const b = (n >>> 16) & 255;
		if (a === 0 || a === 10 || a === 127) return true;
		if (a === 100 && b >= 64 && b <= 127) return true;
		if (a === 169 && b === 254) return true;
		if (a === 172 && b >= 16 && b <= 31) return true;
		if (a === 192 && b === 168) return true;
		if (a >= 224) return true;
		return false;
	}
	function emIpv6Blocked(host) {
		if (host === "::" || host === "::1") return true;
		const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
		if (dotted) {
			const d4 = emParseV4(dotted[1]);
			return d4 === null || emV4Blocked(d4);
		}
		const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
		if (mapped) {
			const hi = parseInt(mapped[1], 16);
			const lo = parseInt(mapped[2], 16);
			if (hi > 65535 || lo > 65535) return true;
			return emV4Blocked(((hi << 16) | lo) >>> 0);
		}
		if (/\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return true;
		let first;
		if (host.slice(0, 2) === "::") first = 0;
		else {
			const head = host.split(":")[0];
			if (!/^[0-9a-f]{1,4}$/.test(head)) return true;
			first = parseInt(head, 16);
		}
		if ((first & 0xfe00) === 0xfc00) return true;
		if ((first & 0xffc0) === 0xfe80) return true;
		if ((first & 0xffc0) === 0xfec0) return true;
		if ((first & 0xff00) === 0xff00) return true;
		return false;
	}
	return function hostBlocked(raw) {
		const host = String(raw || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
		if (!host) return true;
		if (host === "localhost" || emEndsWith(host, ".localhost") || emEndsWith(host, ".local") || emEndsWith(host, ".internal") || emEndsWith(host, ".arpa")) return true;
		if (host.indexOf(":") >= 0) return emIpv6Blocked(host);
		if (/^[0-9.]+$/.test(host)) {
			const v4 = emParseV4(host);
			if (v4 === null) return true;
			return emV4Blocked(v4);
		}
		return false;
	};
})();`;

function patchEmprivacyForWorkers() {
	const NEEDLE = "const hostBlockedImpl = new Function(";
	let sawEmprivacy = false;
	let didPatch = false;
	return {
		name: "emdash:emprivacy-workers-eval-patch",
		enforce: "pre",
		transform(code, id) {
			if (!id.includes("emprivacy")) return null;
			sawEmprivacy = true;
			const start = code.indexOf(NEEDLE);
			if (start === -1) return null;
			const end = code.indexOf(")();", start);
			if (end === -1) return null;
			didPatch = true;
			return {
				code: code.slice(0, start) + EMPRIVACY_EVAL_PATCH + code.slice(end + 4),
				map: null,
			};
		},
		buildEnd() {
			if (sawEmprivacy && !didPatch) {
				this.error(
					"EmPrivacy eval patch did not apply: 'hostBlockedImpl = new Function(' not found. " +
						"The upstream package changed; re-check Workers compatibility before deploying.",
				);
			}
		},
	};
}

export default defineConfig({
	output: "server",
	adapter: cloudflare(),
	image: {
		layout: "constrained",
		responsiveStyles: true,
	},
	vite: {
		plugins: [patchEmprivacyForWorkers()],
		resolve: {
			alias: {
				"emdash-plugin-webhooks-local": localPlugin("webhooks.mjs"),
				"emdash-plugin-resend-local": localPlugin("resend.mjs"),
				// EmPrivacy 3.2.0's `./astro` entry is broken upstream; swap in an
				// empty component map (see the shim for details).
				"@emplugins/emprivacy/astro": localPlugin("emprivacy-astro.mjs"),
			},
		},
		ssr: {
			optimizeDeps: {
				// Pre-bundle so it isn't discovered mid-render, which would trigger
				// a Vite dep re-optimization and break in-flight worker imports
				// under the Cloudflare dev runner (workerd).
				include: ["astro-iconset/components"],
			},
		},
	},
	integrations: [
		react(),
		icon({
			// Only ship the Phosphor icons actually referenced in templates,
			// not the full @iconify-json/ph set (which adds megabytes to the
			// deployed worker bundle).
			include: {
				ph: [
					"arrow-right",
					"bell-simple",
					"buildings",
					"chart-bar",
					"chat-circle",
					"check",
					"check-circle",
					"clock",
					"cloud",
					"code",
					"currency-dollar",
					"envelope",
					"file-text",
					"gauge",
					"globe",
					"heart",
					"leaf",
					"lifebuoy",
					"lightning",
					"list",
					"lock",
					"map-pin",
					"pause",
					"phone",
					"play",
					"plug",
					"plus",
					"shield-check",
					"sparkle",
					"star",
					"sun",
					"thermometer-simple",
					"trend-up",
					"users-three",
					"x",
				],
			},
		}),
		emdash({
			database: d1({ binding: "DB", session: "auto", coalesce: true }),
			storage: r2({ binding: "MEDIA" }),
			plugins: [emprivacyPlugin(), webhooksPlugin(), resendEmailPlugin()],
		}),
	],
	fonts: [
		{
			provider: fontProviders.google(),
			name: "Inter",
			cssVariable: "--font-body",
			weights: [400, 500, 600, 700],
			fallbacks: ["sans-serif"],
		},
		{
			provider: fontProviders.google(),
			name: "Instrument Serif",
			cssVariable: "--font-display",
			weights: [400],
			styles: ["normal", "italic"],
			fallbacks: ["serif"],
		},
	],
	devToolbar: { enabled: false },
});
