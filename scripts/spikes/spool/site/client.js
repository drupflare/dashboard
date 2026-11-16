(() => {
	var b = 'data-spool-client';
	function w(e = l()) {
		return {
			register(n, o = {}) {
				let s = o.hiddenAfterMs ?? 1e4,
					t = !0,
					i = !1,
					r = !1,
					c = !1,
					p = !1,
					d = null,
					g = (a) => {
						try {
							n[a]();
						} catch (P) {
							if (!p) ((p = !0), console.warn('spool.activity', P));
						}
					},
					u = () => {
						if (c) return;
						let a = !t || i;
						if (a === r) return;
						((r = a), g(a ? 'pause' : 'resume'));
					},
					y = () => {
						if (d === null) return;
						(e.clearTimeout(d), (d = null));
					},
					m = () => {
						if (c) return;
						if (!e.hidden()) {
							(y(), (i = !1), u());
							return;
						}
						if (i || d !== null) return;
						if (s <= 0) {
							((i = !0), u());
							return;
						}
						d = e.setTimeout(() => {
							if (((d = null), e.hidden())) ((i = !0), u());
						}, s);
					},
					T = e.onVisibilityChange(m),
					A = o.target
						? e.observe(o.target, (a) => {
								((t = a), u());
							})
						: () => {
								return;
							};
				return (
					m(),
					() => {
						if (c) return;
						if (((c = !0), y(), T(), A(), r)) ((r = !1), g('resume'));
					}
				);
			}
		};
	}
	function l() {
		return {
			hidden: () => document.hidden,
			onVisibilityChange(e) {
				return (
					document.addEventListener('visibilitychange', e),
					() => document.removeEventListener('visibilitychange', e)
				);
			},
			observe(e, n) {
				if (typeof IntersectionObserver > 'u')
					return (
						n(!0),
						() => {
							return;
						}
					);
				let o = new IntersectionObserver(
					(s) => {
						let t = s.at(-1);
						if (t) n(t.isIntersecting || t.intersectionRatio > 0);
					},
					{ threshold: 0 }
				);
				return (o.observe(e), () => o.disconnect());
			},
			setTimeout: (e, n) => setTimeout(e, n),
			clearTimeout: (e) => clearTimeout(e)
		};
	}
	function v(e, n, o = []) {
		let s = 0;
		for (let { name: t } of e) {
			if (o.includes(t)) continue;
			try {
				if (new URL(t).origin !== n) s += 1;
			} catch {
				continue;
			}
		}
		return s;
	}
	function j(e, n, o = [], s = 32) {
		let t = new Map();
		for (let { name: i } of e) {
			if (o.includes(i)) continue;
			try {
				let r = new URL(i).origin;
				if (r !== n && r !== 'null') t.set(r, (t.get(r) ?? 0) + 1);
			} catch {
				continue;
			}
		}
		return Object.fromEntries(
			[...t].sort((i, r) => r[1] - i[1] || (i[0] < r[0] ? -1 : 1)).slice(0, s)
		);
	}
	var R = 1;
	var h = {
		sync: '/.spool/sync',
		artifact: '/.spool/artifact',
		beacon: '/.spool/beacon',
		worker: '/spool-sw.js'
	};
	function E(e, n = window) {
		let o = () => e.close();
		return (n.addEventListener('pagehide', o), () => n.removeEventListener('pagehide', o));
	}
	function f(e, n, o) {
		return new Promise((s, t) => {
			let i = new MessageChannel(),
				r = setTimeout(() => {
					(i.port1.close(), t(Error('the worker did not answer')));
				}, o);
			((i.port1.onmessage = (c) => {
				(clearTimeout(r), i.port1.close(), s(c.data));
			}),
				e.postMessage(n, [i.port2]));
		});
	}
	async function k(e = {}) {
		let n = e.container ?? navigator.serviceWorker;
		if (!n) return null;
		let o = e.helloTimeoutMs ?? 5000;
		(n.addEventListener?.('message', (r) => {
			let c = r.data;
			if (c?.type !== 'spool:cleared') return;
			(e.target ?? window).dispatchEvent(
				new CustomEvent('spool:cleared', { detail: { reason: c.reason } })
			);
		}),
			await n.register(e.workerUrl ?? h.worker, { scope: e.scope, updateViaCache: 'all' }));
		let s = await n.ready,
			t = s.active;
		if (!t) throw Error('the worker is not active');
		let i = await f(t, { type: 'spool:hello', protocol: R }, o);
		return {
			registration: s,
			hello: i,
			status: () => f(s.active ?? t, { type: 'spool:status' }, o),
			view: async (r = location.pathname) =>
				(await f(s.active ?? t, { type: 'spool:view', path: r }, o)).id,
			reportLoads: (r, c, p) =>
				(s.active ?? t).postMessage({ type: 'spool:loads', view: r, count: c, origins: p }),
			track: (r) => E(r)
		};
	}
	var x = k().catch(() => null);
	globalThis.spool = { ready: x, activity: w(l()) };
	x.then(async (e) => {
		let n = await e?.view().catch(() => null);
		if (!e || !n) return;
		let o = -1,
			s = () => {
				let t = document.querySelector(`script[${b}]`)?.src,
					i = performance.getEntriesByType('resource'),
					r = v(i, location.origin, t ? [t] : []);
				if (r === o) return;
				((o = r), e.reportLoads(n, r, j(i, location.origin, t ? [t] : [])));
			};
		(addEventListener('pagehide', s),
			document.addEventListener('visibilitychange', () => {
				if (document.visibilityState === 'hidden') s();
			}));
	});
})();
