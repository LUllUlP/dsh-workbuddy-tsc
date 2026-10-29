/**
 * Host half of the prompt-enhance bundle.
 *
 * Ports WorkBuddy Desktop's "enhance prompt" mechanism: one tools-less model
 * call whose system prompt is the shipped `enhance-prompt-system-prompt`, whose
 * only user message is the composer draft, and whose single text answer replaces
 * the draft in place. The browser half renders the control and owns the draft;
 * this half owns the model call and the HTTP seat between them.
 *
 * Contract of the endpoint (POST, JSON):
 *   request   { text: string, sessionId?: string, provider?: string, model?: string }
 *   success   { ok: true,  text: string }
 *   failure   { ok: false, error: { code: string, message: string } }
 */
import { SYSTEM_PROMPT } from './system-prompt.js';

export const name = 'prompt-enhance';
export const inject = ['llm', 'webServer'];

/** Exact-path browser route; matches the constant the Client module fetches. */
export const ENDPOINT = '/plugins/prompt-enhance/enhance';

const MAX_BODY_BYTES = 256 * 1024;
const MAX_TEXT_CHARS = 32_000;
const DEFAULT_TEMPERATURE = 0.7;

export function apply(ctx, config) {
	const settings = {
		temperature: typeof config?.temperature === 'number' ? config.temperature : DEFAULT_TEMPERATURE,
		maxTextChars: typeof config?.maxTextChars === 'number' ? config.maxTextChars : MAX_TEXT_CHARS,
		system: typeof config?.systemPrompt === 'string' && config.systemPrompt.trim() !== '' ? config.systemPrompt : SYSTEM_PROMPT
	};

	ctx.effect(() => ctx.webServer.register({
		kind: 'exact',
		path: ENDPOINT,
		handler: (req, res) => handle(ctx, settings, req, res)
	}), 'prompt-enhance: enhance endpoint');
}

async function handle(ctx, settings, req, res) {
	if (req.method !== 'POST') {
		send(res, 405, failure('method-not-allowed', 'POST only'));
		return;
	}

	let body;
	try {
		body = parseJson(await readBody(req));
	} catch (error) {
		send(res, 400, failure('bad-request', error instanceof Error ? error.message : String(error)));
		return;
	}

	const raw = typeof body?.text === 'string' ? body.text : '';
	// WorkBuddy sanitizes a zero-width space out of the draft before enhancing.
	const text = raw.replace(/\u200B/g, '').trim();
	if (text === '') {
		send(res, 400, failure('empty-text', 'the draft is empty'));
		return;
	}
	if (text.length > settings.maxTextChars) {
		send(res, 413, failure('text-too-long', `the draft exceeds ${settings.maxTextChars} characters`));
		return;
	}

	const route = resolveRoute(ctx, body);
	if (route === undefined) {
		send(res, 409, failure('no-model-route', 'no model route is available for prompt enhancement'));
		return;
	}

	const controller = new AbortController();
	const abort = () => controller.abort();
	req.on('aborted', abort);
	try {
		const enhanced = sanitize(await enhance(ctx, settings, route, text, body, controller.signal));
		if (enhanced === '') {
			send(res, 200, failure('empty-result', 'the model returned an empty prompt'));
			return;
		}
		send(res, 200, { ok: true, text: enhanced });
	} catch (error) {
		const code = typeof error?.code === 'string' && error.code !== '' ? error.code : 'enhance-failed';
		const message = error instanceof Error ? error.message : String(error);
		send(res, 200, failure(code, message));
	} finally {
		req.off('aborted', abort);
	}
}

/** Stream one completion and return the concatenated assistant text. */
async function enhance(ctx, settings, route, text, body, signal) {
	const options = {
		provider: route.provider,
		model: route.model,
		system: settings.system,
		messages: [{
			role: 'user',
			content: [{ type: 'text', text }]
		}],
		temperature: settings.temperature,
		signal
	};
	if (typeof body?.sessionId === 'string' && body.sessionId !== '') options.sessionId = body.sessionId;

	let out = '';
	let finished = false;
	for await (const chunk of ctx.llm.stream(options)) {
		if (chunk.type === 'text-delta') {
			out += chunk.text;
			continue;
		}
		if (chunk.type !== 'finish') continue;
		finished = true;
		const kind = chunk.reason?.kind;
		if (kind === 'error' || kind === 'aborted') {
			const failureInfo = chunk.reason.failure ?? {};
			const error = new Error(typeof failureInfo.message === 'string' ? failureInfo.message : `model call ended with ${kind}`);
			if (typeof failureInfo.code === 'string') error.code = failureInfo.code;
			throw error;
		}
		if (kind !== 'stop') {
			const error = new Error(`model call ended with ${String(kind)}`);
			error.code = `finish-${String(kind)}`;
			throw error;
		}
	}
	if (!finished) {
		const error = new Error('model call emitted no terminal finish');
		error.code = 'no-finish';
		throw error;
	}
	return out;
}

/**
 * The shipped prompt demands "only the enhanced prompt", so tolerate the small
 * set of wrappers a model still emits and never leak them into the draft.
 */
function sanitize(raw) {
	let text = raw.replace(/\r\n/g, '\n').trim();
	if (text === '') return '';

	const fenced = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(text);
	if (fenced !== null) text = fenced[1].trim();

	const labelled = /^(?:enhanced prompt|enhanced version|prompt|增强后的提示词|优化后的提示词|增强提示词)\s*[:：]\s*/i.exec(text);
	if (labelled !== null) text = text.slice(labelled[0].length).trim();

	const quoted = /^(["“'‘])([\s\S]*)(["”'’])$/.exec(text);
	if (quoted !== null && quoted[2].trim() !== '') text = quoted[2].trim();

	return text;
}

/** Prefer the deployment's default model; accept an explicit route as a fallback. */
function resolveRoute(ctx, body) {
	const selection = ctx.get('agentDefaultModel')?.currentSelection?.();
	if (selection !== undefined && selection !== null && selection.provider !== '' && selection.model !== '') {
		return { provider: selection.provider, model: selection.model };
	}
	if (typeof body?.provider === 'string' && body.provider !== '' && typeof body?.model === 'string' && body.model !== '') {
		return { provider: body.provider, model: body.model };
	}
	return undefined;
}

function failure(code, message) {
	return { ok: false, error: { code, message } };
}

function send(res, status, payload) {
	if (res.writableEnded || res.destroyed) return;
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'content-length': Buffer.byteLength(body),
		'cache-control': 'no-store'
	});
	res.end(body);
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let bytes = 0;
		req.on('data', (chunk) => {
			bytes += chunk.length;
			if (bytes > MAX_BODY_BYTES) {
				reject(new Error('request body is too large'));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', reject);
	});
}

function parseJson(raw) {
	if (raw.trim() === '') throw new Error('request body is empty');
	try {
		return JSON.parse(raw);
	} catch {
		throw new Error('request body is not valid JSON');
	}
}
