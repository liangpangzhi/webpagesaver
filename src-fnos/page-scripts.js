// 页面内执行的脚本集合。
// 每个函数都通过 page.evaluate('(' + fn.toString() + ')(arg)') 注入，函数内不得引用模块作用域变量。

// 1) 触发懒加载：逐步滚动到底再回到顶部，等待字体与图片就绪
async function scrollThrough(opts) {
	opts = opts || {};
	const stepDelay = opts.stepDelay || 150;
	const maxSteps = opts.maxSteps || 60;
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

	const docHeight = () => Math.max(
		document.body ? document.body.scrollHeight : 0,
		document.documentElement.scrollHeight,
		window.innerHeight
	);

	let y = 0;
	let last = 0;
	for (let i = 0; i < maxSteps; i++) {
		const h = docHeight();
		y = Math.min(y + Math.floor(window.innerHeight * 0.85), h);
		window.scrollTo(0, y);
		await sleep(stepDelay);
		if (y >= h && h === last) break;
		last = h;
	}
	window.scrollTo(0, docHeight());
	await sleep(stepDelay * 2);
	window.scrollTo(0, 0);
	await sleep(stepDelay);

	// 强制解码所有图片，避免保存后空白
	const imgs = Array.from(document.images || []);
	await Promise.race([
		Promise.all(imgs.map((img) => {
			if (img.complete) return Promise.resolve();
			return new Promise((res) => {
				img.addEventListener('load', res, { once: true });
				img.addEventListener('error', res, { once: true });
				setTimeout(res, 3000);
			});
		})),
		sleep(8000)
	]);
	try { await document.fonts.ready; } catch (e) { /* ignore */ }

	// 让 <details>/<dialog> 之外的隐藏懒加载块暴露出来（不改变可见性）
	return {
		height: docHeight(),
		images: imgs.length,
		pendingImages: imgs.filter((i) => !i.complete).length
	};
}

// 2) 移除非内容元素：广告、弹窗浮层、遮罩，并还原被脚本锁定的滚动
function cleanPage(opts) {
	opts = opts || {};
	const keepModals = !!opts.keepModals;
	const removed = { ads: 0, popups: 0, overlays: 0, samples: [] };
	const vw = window.innerWidth || 1440;
	const vh = window.innerHeight || 900;
	const viewportArea = vw * vh;

	const AD_SELECTORS = [
		'ins.adsbygoogle',
		'[id^="google_ads"]',
		'[id*="div-gpt-ad"]',
		'[class*="adsbygoogle"]',
		'[class*="advert"]',
		'[id*="advert"]',
		'[class*="sponsor"]',
		'[id*="sponsor"]',
		'[class*="ad-slot"]',
		'[class*="ad-slot"]',
		'[class*="ad-container"]',
		'[class*="ad-wrapper"]',
		'[class*="ad-box"]',
		'[class*="ad-banner"]',
		'[class*="banner-ad"]',
		'[class*="ad-unit"]',
		'[class*="adsense"]',
		'[class*="float-ad"]',
		'[class*="fixed-ad"]',
		'[class*="sticky-ad"]',
		'[class*="interstitial"]',
		'[aria-label*="广告"]',
		'[aria-label*="Advertisement"]',
		'[aria-label*="advertisement"]',
		'iframe[src*="doubleclick.net"]',
		'iframe[src*="googlesyndication.com"]',
		'iframe[src*="adservice.google"]',
		'iframe[src*="adnxs.com"]',
		'iframe[src*="taboola"]',
		'iframe[src*="outbrain"]',
		'iframe[src*="criteo"]',
		'iframe[src*="pubmatic"]',
		'iframe[src*="amazon-adsystem"]'
	];

	const POPUP_SELECTORS = [
		'[class*="popup"]',
		'[id*="popup"]',
		'[class*="modal"]',
		'[id*="modal"]',
		'[class*="overlay"]',
		'[id*="overlay"]',
		'[class*="dialog"]',
		'[role="dialog"]',
		'[aria-modal="true"]',
		'[class*="cookie"]',
		'[id*="cookie"]',
		'[class*="consent"]',
		'[id*="consent"]',
		'[class*="newsletter"]',
		'[class*="subscribe-popup"]',
		'[class*="lightbox"]',
		'[class*="mask-layer"]',
		'[class*="guide-mask"]'
	];

	const textLength = (el) => {
		try { return (el.innerText || '').trim().length; } catch (e) { return 0; }
	};
	const rectOf = (el) => {
		try { return el.getBoundingClientRect(); } catch (e) { return null; }
	};
	const isOverlayLike = (el) => {
		const cs = getComputedStyle(el);
		if (cs.display === 'none' || cs.visibility === 'hidden') return false;
		const pos = cs.position;
		if (pos !== 'fixed' && pos !== 'absolute') return false;
		const z = parseInt(cs.zIndex, 10) || 0;
		if (z < 10) return false;
		const r = rectOf(el);
		if (!r || r.width * r.height <= 0) return false;
		const covers = (r.width * r.height) / viewportArea;
		return covers > 0.05 || (r.width > vw * 0.5 && r.height > vh * 0.4);
	};

	// 关键策略：占据文档流的广告块用"占位隐藏"（visibility:hidden 保留盒子尺寸），
	// 这样广告不可见但页面布局与比例和原页面完全一致；浮层弹窗（fixed/absolute）直接移除。
	const kill = (el, bucket) => {
		if (!el || !el.parentNode) return;
		if (el === document.documentElement || el === document.body) return;
		let pos = 'static';
		try { pos = getComputedStyle(el).position; } catch (e) { pos = 'static'; }
		const inFlow = (pos === 'static' || pos === 'relative' || pos === 'sticky');
		if (removed.samples.length < 40) {
			const cls = (el.getAttribute && (el.getAttribute('class') || el.getAttribute('id') || el.tagName)) || '';
			const r = el.getBoundingClientRect();
			let txt = '';
			try { txt = (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 24); } catch (e) { txt = ''; }
			removed.samples.push(String(bucket) + (inFlow ? '[hold]' : '[cut]') + ': ' + String(cls).slice(0, 40)
				+ ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' y=' + Math.round(r.y + window.scrollY)
				+ (txt ? ' | ' + txt : ''));
		}
		try {
			if (inFlow) {
				el.style.setProperty('visibility', 'hidden', 'important');
				el.setAttribute('data-sf-ad', 'hidden');
				removed[bucket + '_hidden'] = (removed[bucket + '_hidden'] || 0) + 1;
			} else {
				el.parentNode.removeChild(el);
				removed[bucket] = (removed[bucket] || 0) + 1;
			}
		} catch (e) { /* ignore */ }
	};

	// 2.1 广告节点直接移除（关键词命中率高，误删风险低）
	for (const sel of AD_SELECTORS) {
		let nodes = [];
		try { nodes = Array.from(document.querySelectorAll(sel)); } catch (e) { continue; }
		for (const el of nodes) kill(el, 'ads');
	}

	// 2.2 弹窗/浮层：需同时满足"浮层形态"，避免误删正文里的 modal 类名容器
	if (!keepModals) {
		for (const sel of POPUP_SELECTORS) {
			let nodes = [];
			try { nodes = Array.from(document.querySelectorAll(sel)); } catch (e) { continue; }
			for (const el of nodes) {
				if (!el.parentNode) continue;
				if (el === document.documentElement || el === document.body) continue;
				if (!isOverlayLike(el)) continue;
				kill(el, 'popups');
			}
		}
	}

	// 2.3 覆盖层启发式：fixed 定位 + 覆盖面积大 + 高 z-index + 文字量小（典型广告遮罩）
	const all = Array.from(document.querySelectorAll('body *'));
	for (const el of all) {
		if (!el.parentNode) continue;
		const cs = getComputedStyle(el);
		if (cs.position !== 'fixed') continue;
		const z = parseInt(cs.zIndex, 10) || 0;
		if (z < 20) continue;
		const r = rectOf(el);
		if (!r || r.width * r.height <= 0) continue;
		const covers = (r.width * r.height) / viewportArea;
		if (covers < 0.18) continue;
		if (textLength(el) > 1200) continue;
		if (el.querySelector('nav, header, main, article')) continue;
		kill(el, 'overlays');
	}

	// 2.4 还原被弹窗脚本锁定的滚动（很多站点保存后无法滚动就是这里）
	const restored = [];
	const restore = (el, label) => {
		if (!el) return;
		const cs = getComputedStyle(el);
		if (cs.overflow === 'hidden' || cs.overflowY === 'hidden') {
			el.style.setProperty('overflow', 'visible', 'important');
			el.style.setProperty('overflow-y', 'auto', 'important');
			restored.push(label + ' overflow');
		}
		if (el.style && el.style.position === 'fixed' && el === document.body) {
			el.style.setProperty('position', 'static', 'important');
			restored.push('body position');
		}
		const pr = cs.paddingRight;
		if (pr && parseFloat(pr) > 0 && el === document.body && getComputedStyle(document.documentElement).overflowY !== 'scroll') {
			// 弹窗打开时常给 body 加滚动条补偿内边距，移除后会导致右侧留白
			el.style.setProperty('padding-right', '0px', 'important');
			restored.push('body padding-right');
		}
	};
	restore(document.documentElement, 'html');
	restore(document.body, 'body');

	// 2.5 清理残留的高 z-index 空遮罩层（无文字、无图片、半透明黑）
	for (const el of Array.from(document.querySelectorAll('body > div'))) {
		if (!el.parentNode) continue;
		const cs = getComputedStyle(el);
		if (cs.position !== 'fixed') continue;
		if (el.children.length > 0) continue;
		if ((el.innerText || '').trim().length > 0) continue;
		const bg = cs.backgroundColor || '';
		if (/rgba\(\s*0,\s*0,\s*0/.test(bg)) kill(el, 'overlays');
	}

	// 2.6 词法匹配：把 class / id 按分隔符拆词后比对黑名单词
	// 拆词可以避开 header / download / upload / shadow 这类"含 ad 子串但并非广告"的误伤
	const AD_TOKENS = new Set(['ad', 'ads', 'adv', 'adbox', 'adslot', 'adunit', 'advunit', 'advert', 'adverts',
		'advertisement', 'advertising', 'adsense', 'adsbygoogle', 'adzone', 'adwrap', 'adlayer', 'adbanner',
		'dfp', 'gpt', 'sponsor', 'sponsors', 'sponsored', 'promo', 'promotion', 'promoted']);
	const POPUP_TOKENS = new Set(['popup', 'popups', 'modal', 'modals', 'overlay', 'overlays', 'dialog',
		'lightbox', 'interstitial', 'consent', 'cookiebar', 'cookiebanner']);
	const tokensOf = (v) => String(v || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
	const hasTextProtection = (el) => {
		const blocks = el.querySelectorAll('article, main, h1, h2, p, ul, table').length;
		if (blocks > 3) return true;
		const total = el.querySelectorAll('*').length;
		return total > 200;
	};
	let lexBudget = viewportArea * 3.5; // 词法规则最多处理相当于 3.5 屏的面积，防止大面积误伤
	for (const el of Array.from(document.querySelectorAll('body *'))) {
		if (!el.parentNode) continue;
		if (el.hasAttribute('data-sf-ad')) continue;
		if (el.closest('[data-sf-ad]')) continue;
		const toks = tokensOf(el.getAttribute('class')).concat(tokensOf(el.getAttribute('id')));
		if (!toks.length) continue;
		const isAd = toks.some((t) => AD_TOKENS.has(t));
		const isPopup = !keepModals && toks.some((t) => POPUP_TOKENS.has(t));
		if (!isAd && !isPopup) continue;
		const r = rectOf(el);
		if (!r || r.width < 8 || r.height < 8) continue;
		if (hasTextProtection(el)) continue;
		// 图片/链接/正文很多的块多半是内容区，不当广告处理
		if (r.width * r.height > viewportArea * 0.25) {
			if (el.querySelectorAll('img').length > 4) continue;
			if (el.querySelectorAll('a').length > 12) continue;
		}
		if (r.width * r.height > viewportArea * 0.03) {
			const txt = textLength(el);
			if (txt > 120) continue;                      // 有明显正文，判为内容区
			if (txt > 40 && el.querySelectorAll('a').length > 2) continue; // 文字+多链接 → 列表区
		}
		if (lexBudget <= 0) break;
		lexBudget -= r.width * r.height;
		let pos = 'static';
		try { pos = getComputedStyle(el).position; } catch (e) { pos = 'static'; }
		const isFloat = pos === 'fixed' || pos === 'absolute';
		if (isAd) {
			kill(el, 'ads');
		} else if (isPopup && isFloat) {
			// 只是类名叫 modal/popup、但仍在文档流里的容器不动，避免误删正文
			kill(el, 'popups');
		}
	}

	return { removed, restored, viewport: { width: vw, height: vh } };
}

// 3) 采集资源：把需要内联的位置打上 data-sf-* 标记，返回待下载 URL 清单
function collectAssets(opts) {
	opts = opts || {};
	const urls = new Set();
	const addUrl = (u, el) => {
		if (!u) return null;
		u = String(u).trim();
		if (!u || u.startsWith('data:') || u.startsWith('blob:') || u.startsWith('about:') || u.startsWith('javascript:')) return null;
		try {
			const abs = new URL(u, document.baseURI).href;
			if (abs.startsWith('data:')) return null;
			urls.add(abs);
			return abs;
		} catch (e) { return null; }
	};
	const setAttr = (el, name, abs) => {
		if (!abs) return;
		try { el.setAttribute('data-sf-' + name, abs); } catch (e) { /* ignore */ }
	};

	let canvasCount = 0;

	const walk = (root, cb) => {
		const nodes = root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
		for (const el of nodes) {
			cb(el);
			if (el.shadowRoot) walk(el.shadowRoot, cb);
		}
	};

	const CSS_URL_PROPS = ['background-image', 'border-image-source', 'mask-image', '-webkit-mask-image', 'list-style-image', 'cursor', 'content'];
	const inlineCssUrls = (value, el, prop) => {
		if (!value || value === 'none' || value === 'normal') return false;
		if (!/url\(/i.test(value)) return false;
		let changed = false;
		const replaced = value.replace(/url\((['"]?)([^'")]+)\1\)/gi, (m, q, u) => {
			if (u.startsWith('#')) return m;
			const abs = addUrl(u, el);
			if (!abs) return m;
			changed = true;
			return 'url("' + abs + '")';
		});
		if (changed) {
			const store = el.__sfCss || (el.__sfCss = []);
			store.push(prop + ':' + replaced);
		}
		return changed;
	};

	const handleElement = (el) => {
		const tag = el.tagName ? el.tagName.toLowerCase() : '';

		// 已判定为广告的子树（已被占位隐藏）不再采集资源，避免体积暴涨
		try { if (el.closest && el.closest('[data-sf-ad]')) return; } catch (e) { /* ignore */ }
		// 音视频体积巨大且离线播放意义有限，不内联
		if (tag === 'video' || tag === 'audio' || tag === 'source' || tag === 'track') return;

		// 图片类
		if (tag === 'img' || tag === 'input') {
			// 惰性加载兜底：无 src 时尝试常见 data-* 属性
			if (tag === 'img' && !el.getAttribute('src')) {
				const lazy = el.getAttribute('data-src') || el.getAttribute('data-original') || el.getAttribute('data-lazy-src') || el.getAttribute('data-url');
				if (lazy) el.setAttribute('src', lazy);
			}
			const src = el.currentSrc || el.getAttribute('src');
			setAttr(el, 'src', addUrl(src, el));
			const srcset = el.getAttribute('srcset');
			if (srcset) {
				const parts = srcset.split(',').map((s) => {
					const seg = s.trim().split(/\s+/);
					const abs = addUrl(seg[0], el);
					return abs ? { u: abs, d: seg[1] || '' } : null;
				}).filter(Boolean);
				if (parts.length) {
					el.setAttribute('data-sf-srcset', JSON.stringify(parts));
				}
			}
		}
		if (tag === 'source') {
			const srcset = el.getAttribute('srcset');
			if (srcset) {
				const parts = srcset.split(',').map((s) => {
					const seg = s.trim().split(/\s+/);
					const abs = addUrl(seg[0], el);
					return abs ? { u: abs, d: seg[1] || '' } : null;
				}).filter(Boolean);
				if (parts.length) el.setAttribute('data-sf-srcset', JSON.stringify(parts));
			}
			setAttr(el, 'src', addUrl(el.getAttribute('src'), el));
		}
		if (tag === 'video') {
			setAttr(el, 'poster', addUrl(el.getAttribute('poster'), el));
			setAttr(el, 'src', addUrl(el.getAttribute('src'), el));
		}
		if (tag === 'audio' || tag === 'track') {
			setAttr(el, 'src', addUrl(el.getAttribute('src'), el));
		}
		if (tag === 'image' || tag === 'use') {
			// SVG 内部引用（#id 已在 addUrl 中被过滤成相对锚点，这里只处理外部文件）
			setAttr(el, 'href', addUrl(el.getAttribute('href') || el.getAttribute('xlink:href'), el));
		}
		if (tag === 'object') setAttr(el, 'data', addUrl(el.getAttribute('data'), el));
		if (tag === 'embed') setAttr(el, 'src', addUrl(el.getAttribute('src'), el));
		if (tag === 'link') {
			const rel = (el.getAttribute('rel') || '').toLowerCase();
			if (rel.includes('icon') || rel.includes('apple-touch-icon') || rel.includes('preload') || rel.includes('mask-icon')) {
				setAttr(el, 'href', addUrl(el.getAttribute('href'), el));
			}
		}

		// canvas → 转成图片（保留视觉元素）
		if (tag === 'canvas') {
			try {
				const c = el;
				if (c.width > 0 && c.height > 0) {
					const data = c.toDataURL('image/png');
					if (data && data.length > 100) {
						el.setAttribute('data-sf-canvas', data);
						canvasCount++;
					}
				}
			} catch (e) { /* 跨域污染，跳过 */ }
		}

		// inline style 中的 url()
		const styleAttr = el.getAttribute && el.getAttribute('style');
		if (styleAttr && /url\(/i.test(styleAttr)) {
			const replaced = styleAttr.replace(/url\((['"]?)([^'")]+)\1\)/gi, (m, q, u) => {
				if (u.startsWith('#')) return m;
				const abs = addUrl(u, el);
				return abs ? 'url("' + abs + '")' : m;
			});
			if (replaced !== styleAttr) el.setAttribute('data-sf-style', replaced);
		}

		// computed 样式中的资源（动态注入的背景图、光标、遮罩等）
		if (el.nodeType === 1) {
			let cs;
			try { cs = getComputedStyle(el); } catch (e) { cs = null; }
			if (cs) {
				for (const prop of CSS_URL_PROPS) {
					if (prop === 'content') continue;
					let v = '';
					try { v = cs.getPropertyValue(prop); } catch (e) { v = ''; }
					inlineCssUrls(v, el, prop);
				}
			}
			// 伪元素背景
			for (const pseudo of ['::before', '::after']) {
				try {
					const pcs = getComputedStyle(el, pseudo);
					if (!pcs) continue;
					const bg = pcs.getPropertyValue('background-image');
					if (bg && bg !== 'none' && /url\(/i.test(bg)) {
						const replaced = bg.replace(/url\((['"]?)([^'")]+)\1\)/gi, (m, q, u) => {
							if (u.startsWith('#')) return m;
							const abs = addUrl(u, el);
							return abs ? 'url("' + abs + '")' : m;
						});
						if (replaced !== bg) {
							const rules = window.__sfPseudoRules || (window.__sfPseudoRules = []);
							rules.push({ index: rules.length, backgroundImage: replaced });
							el.setAttribute('data-sf-pseudo', String(rules.length - 1));
						}
					}
				} catch (e) { /* ignore */ }
			}
		}
	};

	walk(document, handleElement);

	// 外部样式表：内容交给 Node 端下载并递归内联（页面端拿不到跨域 CSS 文本）
	const cssLinks = [];
	for (const link of Array.from(document.querySelectorAll('link[rel~="stylesheet"], link[rel="stylesheet"]'))) {
		const href = link.getAttribute('href');
		if (!href) continue;
		try {
			const abs = new URL(href, document.baseURI).href;
			if (abs.startsWith('data:')) continue;
			cssLinks.push({ href: abs, media: link.getAttribute('media') || '' });
			link.setAttribute('data-sf-css', abs);
		} catch (e) { /* ignore */ }
	}

	// <style> 内的 url() 一并交给 Node 处理不了（页面端已解析），这里就地标记
	const inlineStyles = [];
	Array.from(document.querySelectorAll('style')).forEach((styleEl) => {
		const text = styleEl.textContent || '';
		if (/url\(/i.test(text)) {
			inlineStyles.push(text.length);
		}
	});

	return {
		urls: Array.from(urls),
		cssLinks,
		canvasCount,
		pseudoCount: (window.__sfPseudoRules || []).length,
		docHeight: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
		viewport: { width: window.innerWidth, height: window.innerHeight }
	};
}

// 4) 回填：把下载好的 data URI 写回文档，处理 script/iframe/shadow DOM，返回最终 HTML
function applyAssets(payload) {
	const assets = payload.assets || {};
	const styles = payload.styles || {};
	const options = payload.options || {};
	const keepScripts = !!options.keepScripts;
	const fixedLayoutWidth = options.fixedLayoutWidth || 0;
	const dropIframes = !!options.dropIframes;

	const stats = { replaced: 0, missing: [], scripts: 0, iframes: 0, shadows: 0, canvases: 0 };
	const lookup = (u) => assets[u] || assets[u.replace(/#.*$/, '')] || null;

	const walk = (root, cb) => {
		const nodes = root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
		for (const el of nodes) {
			cb(el);
			if (el.shadowRoot) walk(el.shadowRoot, cb);
		}
	};

	const swapCssUrls = (css) => {
		return String(css).replace(/url\((['"]?)([^'")]+)\1\)/gi, (m, q, u) => {
			const hit = lookup(u);
			if (hit) { stats.replaced++; return 'url("' + hit + '")'; }
			return m;
		});
	};

	// 4.1 外部样式表 → <style>
	for (const link of Array.from(document.querySelectorAll('link[data-sf-css]'))) {
		const href = link.getAttribute('data-sf-css');
		const css = styles[href];
		if (typeof css !== 'string') continue;
		const styleEl = document.createElement('style');
		const media = link.getAttribute('media');
		if (media) styleEl.setAttribute('media', media);
		styleEl.textContent = swapCssUrls(css);
		link.parentNode.replaceChild(styleEl, link);
	}

	// 4.2 元素级资源回填
	const handle = (el) => {
		const tag = el.tagName ? el.tagName.toLowerCase() : '';

		const attrSrc = el.getAttribute && el.getAttribute('data-sf-src');
		if (attrSrc) {
			const data = lookup(attrSrc);
			if (data) {
				el.setAttribute('src', data);
				stats.replaced++;
			} else {
				stats.missing.push(attrSrc);
				el.setAttribute('src', attrSrc);
			}
		}
		const attrHref = el.getAttribute && el.getAttribute('data-sf-href');
		if (attrHref) {
			const data = lookup(attrHref);
			if (data) {
				el.setAttribute('href', data);
				if (el.getAttribute('xlink:href')) el.setAttribute('xlink:href', data);
				stats.replaced++;
			}
		}
		const attrPoster = el.getAttribute && el.getAttribute('data-sf-poster');
		if (attrPoster) {
			const data = lookup(attrPoster);
			if (data) { el.setAttribute('poster', data); stats.replaced++; }
		}
		const attrData = el.getAttribute && el.getAttribute('data-sf-data');
		if (attrData) {
			const data = lookup(attrData);
			if (data) { el.setAttribute('data', data); stats.replaced++; }
		}
		const srcset = el.getAttribute && el.getAttribute('data-sf-srcset');
		if (srcset) {
			try {
				const parts = JSON.parse(srcset);
				const out = parts.map((p) => {
					const data = lookup(p.u);
					if (data) { stats.replaced++; return data + (p.d ? ' ' + p.d : ''); }
					stats.missing.push(p.u);
					return p.u + (p.d ? ' ' + p.d : '');
				});
				el.setAttribute('srcset', out.join(', '));
			} catch (e) { /* ignore */ }
		}
		const styleAttr = el.getAttribute && el.getAttribute('data-sf-style');
		if (styleAttr) {
			el.setAttribute('style', swapCssUrls(styleAttr));
		}
		if (el.__sfCss && el.__sfCss.length) {
			let extra = el.__sfCss.map(swapCssUrls).join(';');
			const cur = el.getAttribute('style') || '';
			el.setAttribute('style', cur + ';' + extra);
		}
		const canvasData = el.getAttribute && el.getAttribute('data-sf-canvas');
		if (canvasData && tag === 'canvas') {
			const img = document.createElement('img');
			img.setAttribute('src', canvasData);
			img.setAttribute('width', el.getAttribute('width') || String(el.width || ''));
			img.setAttribute('height', el.getAttribute('height') || String(el.height || ''));
			const cls = el.getAttribute('class');
			if (cls) img.setAttribute('class', cls);
			img.setAttribute('style', el.getAttribute('style') || '');
			if (el.parentNode) {
				el.parentNode.replaceChild(img, el);
				stats.canvases++;
			}
		}
		// 清理私有标记
		if (el.getAttributeNames) {
			for (const name of el.getAttributeNames()) {
				if (name.startsWith('data-sf-')) el.removeAttribute(name);
			}
		}
	};
	walk(document, handle);

	// 4.3 伪元素背景规则
	const pseudoRules = window.__sfPseudoRules || [];
	if (pseudoRules.length) {
		let css = '';
		pseudoRules.forEach((rule, i) => {
			const sel = '[data-sf-pseudo="' + i + '"]';
			css += sel + '::before{background-image:' + swapCssUrls(rule.backgroundImage) + ' !important;}';
			css += sel + '::after{background-image:' + swapCssUrls(rule.backgroundImage) + ' !important;}';
		});
		const styleEl = document.createElement('style');
		styleEl.setAttribute('id', '__sf-pseudo');
		styleEl.textContent = css;
		(document.head || document.documentElement).appendChild(styleEl);
		Array.from(document.querySelectorAll('[data-sf-pseudo]')).forEach((el) => el.removeAttribute('data-sf-pseudo'));
	}

	// 4.4 <style> 内联样式里的 url() 同样替换
	for (const styleEl of Array.from(document.querySelectorAll('style'))) {
		const text = styleEl.textContent || '';
		if (/url\(/i.test(text)) styleEl.textContent = swapCssUrls(text);
	}

	// 4.5 脚本处理（默认移除，避免保存后弹窗复现、页面被重写）
	if (!keepScripts) {
		for (const s of Array.from(document.querySelectorAll('script'))) {
			if (s.id === '__sf-layout') continue;
			if (s.parentNode) { s.parentNode.removeChild(s); stats.scripts++; }
		}
		// noscript 内容在移除脚本后应可见
		for (const ns of Array.from(document.querySelectorAll('noscript'))) {
			const html = ns.textContent || '';
			if (html.trim()) {
				const tpl = document.createElement('template');
				tpl.innerHTML = html;
				if (tpl.content.childNodes.length) {
					ns.parentNode.replaceChild(tpl.content, ns);
				}
			}
		}
	}

	// 4.6 iframe：同源/跨域由 Node 端逐个 frame 抓取后以 srcdoc 注入，这里先清空 src 防联网
	if (dropIframes) {
		for (const f of Array.from(document.querySelectorAll('iframe, frame'))) {
			if (f.parentNode) { f.parentNode.removeChild(f); stats.iframes++; }
		}
	}

	// 4.7 扁平化 shadow DOM（以 Declarative Shadow DOM 形式保留）
	const flattenShadow = (root) => {
		for (const el of Array.from(root.querySelectorAll ? root.querySelectorAll('*') : [])) {
			if (el.shadowRoot) {
				const tpl = document.createElement('template');
				tpl.setAttribute('shadowrootmode', 'open');
				const clone = el.shadowRoot.cloneNode(true);
				// 复制 shadow 内的样式表与节点
				tpl.innerHTML = clone.innerHTML;
				el.appendChild(tpl);
				stats.shadows++;
			}
			if (el.shadowRoot) flattenShadow(el.shadowRoot);
		}
	};
	try { flattenShadow(document); } catch (e) { /* ignore */ }

	// 4.8 文档头清理：CSP / base 会破坏内联效果
	for (const meta of Array.from(document.querySelectorAll('meta[http-equiv]'))) {
		const eq = (meta.getAttribute('http-equiv') || '').toLowerCase();
		if (eq === 'content-security-policy' || eq === 'refresh') meta.remove();
	}
	for (const base of Array.from(document.querySelectorAll('base'))) base.remove();

	// 4.9 保持页面比例：固定渲染宽度 + 防止窄窗口压缩布局
	if (fixedLayoutWidth > 0) {
		let vp = document.querySelector('meta[name="viewport"]');
		if (!vp) {
			vp = document.createElement('meta');
			vp.setAttribute('name', 'viewport');
			(document.head || document.documentElement).appendChild(vp);
		}
		vp.setAttribute('content', 'width=' + fixedLayoutWidth + ', initial-scale=1');
		const layoutStyle = document.createElement('style');
		layoutStyle.setAttribute('id', '__sf-layout');
		layoutStyle.textContent = [
			'html{overflow-y:auto !important;overflow-x:auto !important;}',
			'body{min-width:' + fixedLayoutWidth + 'px !important;}',
			'*,*::before,*::after{animation-play-state:paused !important;}',
			'[class*="blur"],[id*="blur"]{filter:none !important;}'
		].join('\n');
		(document.head || document.documentElement).appendChild(layoutStyle);
		stats.fixedLayout = fixedLayoutWidth;
	}

	const doctype = document.doctype ? new XMLSerializer().serializeToString(document.doctype) : '<!DOCTYPE html>';
	let html = document.documentElement.outerHTML;
	if (!/^<!doctype/i.test(html)) html = doctype + '\n' + html;

	return { html, stats };
}

module.exports = { scrollThrough, cleanPage, collectAssets, applyAssets };
