<script lang="ts">
import { defineComponent, h, resolveComponent, type PropType, type VNode } from 'vue';
import type { MElement, MNode } from '~/server/services/doc-mirror-render';
import { safeHref, safeImageSrc } from '~/shared/doc-mirrors';

const MAX_DEPTH = 200;
const SAFE_ID = /^[A-Za-z0-9_%.-]+$/;
const SAFE_LANG = /^[A-Za-z0-9_+-]{1,20}$/;

type Child = VNode | string;

function text(nodes: MNode[] | undefined): string {
	return (nodes ?? []).map((n) => (typeof n === 'string' ? n : text(n.c))).join('');
}

export default defineComponent({
	name: 'DocsMirrorBlock',
	props: { nodes: { type: Array as PropType<MNode[]>, required: true } },
	setup(props) {
		const link = resolveComponent('NuxtLink');

		function many(nodes: MNode[] | undefined, depth: number): Child[] {
			return (nodes ?? []).map((node) =>
				typeof node === 'string' ? node : one(node, depth + 1)
			);
		}

		function one(n: MElement, depth: number): Child {
			if (depth > MAX_DEPTH) return text(n.c);
			const kids = () => many(n.c, depth);
			switch (n.t) {
				case 'p':
					return h('p', kids());
				case 'h': {
					const level = Math.min(6, Math.max(1, Number(n.level) || 2));
					const id = n.id && SAFE_ID.test(n.id) ? n.id : undefined;
					return h(`h${level}`, { id }, kids());
				}
				case 'ul':
					return h('ul', kids());
				case 'ol':
					return h(
						'ol',
						{ start: Number.isInteger(n.start) ? n.start : undefined },
						kids()
					);
				case 'li':
					return h('li', kids());
				case 'bq':
					return h('blockquote', kids());
				case 'pre':
					return h('pre', [
						h(
							'code',
							{
								class:
									n.lang && SAFE_LANG.test(n.lang)
										? `language-${n.lang}`
										: undefined
							},
							text(n.c)
						)
					]);
				case 'code':
					return h('code', text(n.c));
				case 'em':
					return h('em', kids());
				case 'strong':
					return h('strong', kids());
				case 'del':
					return h('del', kids());
				case 'sup':
					return h('sup', kids());
				case 'br':
					return h('br');
				case 'hr':
					return h('hr');
				case 'task':
					return h('input', {
						type: 'checkbox',
						disabled: true,
						checked: n.checked === true
					});
				case 'a': {
					const href = safeHref(n.href);
					if (!href) return h('span', kids());
					if (href.startsWith('/docs/')) return h(link, { to: href }, () => kids());
					const external = !href.startsWith('#');
					return h(
						'a',
						{ href, rel: external ? 'noopener noreferrer' : undefined },
						kids()
					);
				}
				case 'img': {
					const src = safeImageSrc(n.src);
					if (!src) return typeof n.alt === 'string' ? n.alt : '';
					return h('img', {
						src,
						alt: typeof n.alt === 'string' ? n.alt : '',
						loading: 'lazy',
						decoding: 'async'
					});
				}
				case 'table':
					return h('div', { class: 'overflow-x-auto' }, [
						h('table', [h('tbody', kids())])
					]);
				case 'tr':
					return h('tr', kids());
				case 'th':
				case 'td':
					return h(n.t, { style: n.align ? { textAlign: n.align } : undefined }, kids());
				default:
					return text(n.c);
			}
		}

		return () => many(props.nodes, 0);
	}
});
</script>
