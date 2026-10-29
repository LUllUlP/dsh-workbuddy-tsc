/**
 * Client half of the prompt-enhance bundle.
 *
 * Renders WorkBuddy's composer "enhance prompt" control beside the submit
 * action and reproduces its state machine against this Harness's draft API:
 *
 *   idle → click → loading (click again cancels) → done (click reverts) 
 *                                              ↘ error (message on the control)
 *
 * The draft is read from the `useInput` snapshot and replaced through
 * `inputActions.setDraft`, so the whole draft is rewritten in place — chips and
 * attachments stay attached, matching WorkBuddy's text-block-only rewrite.
 */
window.__ModuleLoader__.load({
	id: '@local/prompt-enhance',
	factory(require) {
		const React = require('react');
		const h = React.createElement;

		const ENDPOINT = '/plugins/prompt-enhance/enhance';
		const MIN_TEXT_LENGTH = 1;

		const zh = typeof navigator !== 'undefined' && /^zh/i.test(navigator.language || '');
		const TEXT = zh
			? {
				enhance: '增强提示词',
				enhancing: '正在增强…（点击取消）',
				revert: '还原为原始提示词',
				failed: '增强失败',
				empty: '先输入内容再增强'
			}
			: {
				enhance: 'Enhance prompt',
				enhancing: 'Enhancing… (click to cancel)',
				revert: 'Restore the original prompt',
				failed: 'Enhancement failed',
				empty: 'Type something to enhance'
			};

		const BUTTON_STYLE = {
			display: 'inline-flex',
			alignItems: 'center',
			justifyContent: 'center',
			width: 28,
			height: 28,
			padding: 0,
			margin: 0,
			border: 'none',
			borderRadius: 6,
			background: 'transparent',
			color: 'inherit',
			lineHeight: 0,
			cursor: 'pointer'
		};

		/** Four-point sparkle: the enhancement mark. */
		function SparkleIcon() {
			return h('svg', { viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': true, focusable: false },
				h('path', {
					d: 'M8 1.6l1.42 3.98L13.4 7l-3.98 1.42L8 12.4 6.58 8.42 2.6 7l3.98-1.42z',
					fill: 'currentColor'
				}),
				h('path', {
					d: 'M12.6 10.6l.62 1.72 1.72.62-1.72.62-.62 1.72-.62-1.72-1.72-.62 1.72-.62z',
					fill: 'currentColor',
					opacity: 0.6
				}));
		}

		/** Rotation without CSS keyframes: one SMIL animateTransform. */
		function SpinnerIcon() {
			return h('svg', { viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': true, focusable: false },
				h('circle', {
					cx: 8,
					cy: 8,
					r: 5.6,
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: 1.6,
					strokeLinecap: 'round',
					strokeDasharray: '26 10'
				}, h('animateTransform', {
					attributeName: 'transform',
					type: 'rotate',
					from: '0 8 8',
					to: '360 8 8',
					dur: '0.9s',
					repeatCount: 'indefinite'
				})));
		}

		/** Undo arrow: the revert mark once an enhanced draft is in place. */
		function RevertIcon() {
			return h('svg', { viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': true, focusable: false },
				h('path', {
					d: 'M6.2 3.4L2.6 7l3.6 3.6',
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: 1.5,
					strokeLinecap: 'round',
					strokeLinejoin: 'round'
				}),
				h('path', {
					d: 'M2.6 7h6.6a3.2 3.2 0 010 6.4H6.6',
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: 1.5,
					strokeLinecap: 'round',
					strokeLinejoin: 'round'
				}));
		}

		function EnhanceControl(props) {
			const useInput = props.useInput;
			const inputActions = props.inputActions;
			const sessionId = props.sessionId;

			const draft = useInput((state) => state.draft);
			const [status, setStatus] = React.useState('idle');
			const [message, setMessage] = React.useState('');

			const draftRef = React.useRef(draft);
			draftRef.current = draft;
			const backupRef = React.useRef(null);
			const appliedRef = React.useRef(null);
			const abortRef = React.useRef(null);
			const runRef = React.useRef(0);

			// WorkBuddy drops its revert offer as soon as the content moves on.
			React.useEffect(() => {
				if (status !== 'done') return;
				if (draft === appliedRef.current) return;
				backupRef.current = null;
				appliedRef.current = null;
				setStatus('idle');
			}, [draft, status]);

			React.useEffect(() => () => {
				runRef.current += 1;
				if (abortRef.current !== null) abortRef.current.abort();
			}, []);

			const currentText = () => {
				const value = typeof draftRef.current === 'string' ? draftRef.current : '';
				return value.replace(/\u200B/g, '').trim();
			};

			const enhance = async () => {
				const source = currentText();
				if (source.length < MIN_TEXT_LENGTH) {
					setMessage(TEXT.empty);
					return;
				}

				if (abortRef.current !== null) abortRef.current.abort();
				const controller = new AbortController();
				abortRef.current = controller;
				const run = runRef.current + 1;
				runRef.current = run;

				backupRef.current = typeof draftRef.current === 'string' ? draftRef.current : '';
				appliedRef.current = null;
				setMessage('');
				setStatus('loading');

				const body = { text: source };
				if (typeof sessionId === 'string' && sessionId !== '') body.sessionId = sessionId;

				try {
					const response = await fetch(ENDPOINT, {
						method: 'POST',
						credentials: 'same-origin',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify(body),
						signal: controller.signal
					});
					const payload = await response.json().catch(() => null);
					if (run !== runRef.current) return;
					if (payload === null || payload.ok !== true || typeof payload.text !== 'string') {
						const detail = payload !== null && payload.error !== undefined && typeof payload.error.message === 'string'
							? payload.error.message
							: `${TEXT.failed} (HTTP ${response.status})`;
						throw new Error(detail);
					}
					appliedRef.current = payload.text;
					inputActions.setDraft(payload.text);
					setStatus('done');
				} catch (failure) {
					if (run !== runRef.current) return;
					if (failure !== null && typeof failure === 'object' && failure.name === 'AbortError') {
						backupRef.current = null;
						appliedRef.current = null;
						setStatus('idle');
						return;
					}
					appliedRef.current = null;
					setMessage(failure instanceof Error && failure.message !== '' ? failure.message : TEXT.failed);
					setStatus('error');
				} finally {
					if (run === runRef.current) abortRef.current = null;
				}
			};

			const revert = () => {
				const backup = backupRef.current;
				backupRef.current = null;
				appliedRef.current = null;
				setMessage('');
				setStatus('idle');
				if (typeof backup === 'string') inputActions.setDraft(backup);
			};

			const onClick = () => {
				if (status === 'loading') {
					runRef.current += 1;
					if (abortRef.current !== null) {
						abortRef.current.abort();
						abortRef.current = null;
					}
					backupRef.current = null;
					appliedRef.current = null;
					setStatus('idle');
					setMessage('');
					return;
				}
				if (status === 'done' && backupRef.current !== null) {
					revert();
					return;
				}
				void enhance();
			};

			const empty = currentText().length < MIN_TEXT_LENGTH;
			const disabled = status !== 'loading' && status !== 'done' && empty;

			const label = status === 'loading'
				? TEXT.enhancing
				: status === 'done'
					? TEXT.revert
					: status === 'error'
						? `${TEXT.failed}: ${message}`
						: TEXT.enhance;

			const icon = status === 'loading' ? SpinnerIcon() : status === 'done' ? RevertIcon() : SparkleIcon();

			return h('button', {
				type: 'button',
				'data-prompt-enhance': status,
				title: label,
				'aria-label': label,
				disabled,
				onClick,
				style: {
					...BUTTON_STYLE,
					opacity: disabled ? 0.35 : status === 'error' ? 1 : 0.72,
					color: status === 'error' ? 'var(--bt-danger, #e5534b)' : 'inherit'
				}
			}, icon);
		}

		return {
			inject: ['slots'],
			apply(ctx) {
				ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
					name: 'conversation.input.right',
					id: 'prompt-enhance',
					order: 35
				}, EnhanceControl));
			}
		};
	}
});
