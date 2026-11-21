import GithubSlugger from 'github-slugger';
import type { Content, Definition, Parent, PhrasingContent, Root, TableCell } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import {
	MIRROR_LIMITS,
	mirrorAssetRoute,
	mirrorRoute,
	safeHref,
	type DocMirror
} from '../../shared/doc-mirrors';

export type MNode = string | MElement;

export interface MElement {
	t:
		| 'p'
		| 'h'
		| 'ul'
		| 'ol'
		| 'li'
		| 'bq'
		| 'pre'
		| 'code'
		| 'em'
		| 'strong'
		| 'del'
		| 'a'
		| 'img'
		| 'br'
		| 'hr'
		| 'table'
		| 'tr'
		| 'th'
		| 'td'
		| 'sup'
		| 'task';
	c?: MNode[];
	level?: number;
	id?: string;
	href?: string;
	ext?: boolean;
	src?: string;
	alt?: string;
	lang?: string;
	start?: number;
	align?: 'left' | 'center' | 'right';
	checked?: boolean;
}

export interface TocLink {
	id: string;
	text: string;
	level: number;
}

export interface SearchSection {
	id: string;
	title: string;
	titles: string[];
	level: number;
	content: string;
}

export interface RenderedPage {
	title: string;
	hasH1: boolean;
	failed?: boolean;
	nodes: MNode[];
	toc: TocLink[];
	sections: { level: number; id: string; title: string; content: string }[];
}

export interface RenderContext {
	mirror: DocMirror;
	// repo path of the page being rendered
	path: string;
	// every mirrored page by repo path
	pages: ReadonlyMap<string, string>;
	// every cached image by repo path
	assets: ReadonlySet<string>;
}

const FRONTMATTER = /^﻿?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

export function stripFrontmatter(source: string): string {
	return source.replace(FRONTMATTER, '');
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function textOf(node: unknown, depth = 0): string {
	if (depth > 64 || typeof node !== 'object' || node === null) return '';
	const n = node as { value?: unknown; alt?: unknown; children?: unknown[] };
	if (typeof n.value === 'string' && !('children' in n)) {
		return (node as { type?: string }).type === 'html' ? '' : n.value;
	}
	if (Array.isArray(n.children))
		return n.children.map((child) => textOf(child, depth + 1)).join('');
	return typeof n.alt === 'string' ? n.alt : '';
}

function repoUrl(mirror: DocMirror, path: string): string {
	const segments = path.split('/').filter(Boolean).map(encodeURIComponent);
	return segments.length
		? `https://github.com/${mirror.repo}/blob/${mirror.ref}/${segments.join('/')}`
		: `https://github.com/${mirror.repo}`;
}

interface Target {
	href: string;
	ext: boolean;
	asset: boolean;
}

// a link target in a mirrored page; null when the link must not render as a link
export function resolveTarget(raw: string, ctx: RenderContext): Target | null {
	const url = raw.trim();
	if (url === '') return null;
	if (url.startsWith('#')) {
		const href = safeHref(`#${encodeURIComponent(decodeSafely(url.slice(1)))}`);
		return href ? { href, ext: false, asset: false } : null;
	}
	if (SCHEME.test(url)) {
		const href = safeHref(url);
		return href ? { href, ext: true, asset: false } : null;
	}
	if (url.startsWith('//') || url.startsWith('\\')) return null;

	const hashAt = url.search(/[?#]/);
	const pathPart = hashAt === -1 ? url : url.slice(0, hashAt);
	const hashPart = url.includes('#') ? url.slice(url.indexOf('#') + 1) : '';
	const dir = ctx.path.includes('/') ? ctx.path.slice(0, ctx.path.lastIndexOf('/') + 1) : '';
	let resolved: string;
	try {
		resolved = decodeURIComponent(
			new URL(pathPart, `https://repo.invalid/${dir}`).pathname.replace(/^\//, '')
		);
	} catch {
		return null;
	}
	const hash = hashPart ? `#${encodeURIComponent(decodeSafely(hashPart))}` : '';

	const candidates =
		resolved === '' || resolved.endsWith('/')
			? [`${resolved}README.md`, `${resolved}index.md`, `${resolved}docs/README.md`]
			: [resolved];
	for (const candidate of candidates) {
		const key = ctx.pages.get(candidate);
		if (key !== undefined) {
			const href = safeHref(`${mirrorRoute(ctx.mirror, key)}${hash}`);
			return href ? { href, ext: false, asset: false } : null;
		}
	}
	if (ctx.assets.has(resolved)) {
		const href = safeHref(mirrorAssetRoute(ctx.mirror, resolved));
		return href ? { href, ext: false, asset: true } : null;
	}
	const href = safeHref(`${repoUrl(ctx.mirror, resolved.replace(/\/$/, ''))}${hash}`);
	return href ? { href, ext: true, asset: false } : null;
}

function decodeSafely(text: string): string {
	try {
		return decodeURIComponent(text);
	} catch {
		return text;
	}
}

export function renderMarkdown(source: string, ctx: RenderContext): RenderedPage {
	let root: Root;
	try {
		root = fromMarkdown(stripFrontmatter(source), {
			extensions: [gfm()],
			mdastExtensions: [gfmFromMarkdown()]
		});
	} catch {
		// a parser stack overflow on hostile nesting; the page shows a notice instead of its text
		return {
			title: ctx.path.split('/').pop()?.replace(/\.md$/, '') ?? '',
			hasH1: false,
			failed: true,
			nodes: [
				{ t: 'p', c: ['This page cannot be shown here. Open the original to read it.'] }
			],
			toc: [],
			sections: []
		};
	}

	const definitions = new Map<string, Definition>();
	const footnotes = new Map<string, number>();
	const collect = (node: Content | Root, depth: number) => {
		if (depth > MIRROR_LIMITS.depth * 4) return;
		if (node.type === 'definition') definitions.set(node.identifier.toLowerCase(), node);
		if ('children' in node) {
			for (const child of node.children as Content[]) collect(child, depth + 1);
		}
	};
	collect(root, 0);

	const slugger = new GithubSlugger();
	const toc: TocLink[] = [];
	const sections: RenderedPage['sections'] = [];
	let budget: number = MIRROR_LIMITS.nodesPerPage;
	let title = '';
	let hasH1 = false;

	const note = (text: string) => {
		const section = sections[sections.length - 1];
		if (!section || text.trim() === '') return;
		if (section.content.length < MIRROR_LIMITS.sectionChars) {
			section.content = `${section.content} ${text.trim()}`
				.trim()
				.slice(0, MIRROR_LIMITS.sectionChars);
		}
	};

	const linkNode = (target: Target | null, children: MNode[], fallback: MNode[]): MNode[] => {
		if (!target) return fallback;
		return [{ t: 'a', href: target.href, ext: target.ext, c: children }];
	};

	// inLink: an image that renders as a link inside a link would nest anchors, which the HTML parser splits
	function inline(nodes: readonly PhrasingContent[], depth: number, inLink = false): MNode[] {
		const out: MNode[] = [];
		for (const node of nodes) {
			if (budget <= 0) break;
			budget -= 1;
			if (depth > MIRROR_LIMITS.depth) {
				out.push(textOf(node));
				continue;
			}
			switch (node.type) {
				case 'text':
					out.push(node.value);
					break;
				case 'emphasis':
					out.push({ t: 'em', c: inline(node.children, depth + 1, inLink) });
					break;
				case 'strong':
					out.push({ t: 'strong', c: inline(node.children, depth + 1, inLink) });
					break;
				case 'delete':
					out.push({ t: 'del', c: inline(node.children, depth + 1, inLink) });
					break;
				case 'inlineCode':
					out.push({ t: 'code', c: [node.value] });
					break;
				case 'break':
					out.push({ t: 'br' });
					break;
				case 'link': {
					const target = resolveTarget(node.url, ctx);
					const children = inline(node.children, depth + 1, target !== null);
					out.push(...linkNode(target, children, children));
					break;
				}
				case 'linkReference': {
					const def = definitions.get(node.identifier.toLowerCase());
					const target = def ? resolveTarget(def.url, ctx) : null;
					const children = inline(node.children, depth + 1, target !== null);
					out.push(...linkNode(target, children, children));
					break;
				}
				case 'image':
				case 'imageReference': {
					const url =
						node.type === 'image'
							? node.url
							: (definitions.get(node.identifier.toLowerCase())?.url ?? '');
					const alt = node.alt ?? '';
					const target = resolveTarget(url, ctx);
					if (target?.asset) out.push({ t: 'img', src: target.href, alt });
					else if (target && !inLink) {
						out.push({
							t: 'a',
							href: target.href,
							ext: target.ext,
							c: [alt || 'Image']
						});
					} else out.push(inLink && target ? alt || 'Image' : alt);
					break;
				}
				case 'footnoteReference': {
					const n = footnotes.get(node.identifier) ?? footnotes.size + 1;
					footnotes.set(node.identifier, n);
					out.push({ t: 'sup', c: [`[${n}]`] });
					break;
				}
				// raw HTML never renders
				case 'html':
					break;
				default:
					out.push(textOf(node));
			}
		}
		return out;
	}

	function cells(
		row: { children: TableCell[] },
		head: boolean,
		align: (string | null)[]
	): MElement {
		return {
			t: 'tr',
			c: row.children.map((cell, i) => {
				const a = align[i];
				note(textOf(cell));
				return {
					t: head ? 'th' : 'td',
					align: a === 'left' || a === 'center' || a === 'right' ? a : undefined,
					c: inline(cell.children, 1)
				} satisfies MElement;
			})
		};
	}

	function blocks(nodes: readonly Content[], depth: number): MNode[] {
		const out: MNode[] = [];
		for (const node of nodes) {
			if (budget <= 0) break;
			budget -= 1;
			if (depth > MIRROR_LIMITS.depth) {
				const text = textOf(node);
				if (text) out.push({ t: 'p', c: [text] });
				continue;
			}
			switch (node.type) {
				case 'paragraph': {
					note(textOf(node));
					out.push({ t: 'p', c: inline(node.children, depth + 1) });
					break;
				}
				case 'heading': {
					const text = textOf(node).trim();
					let level: number = node.depth;
					if (level === 1) {
						if (hasH1) level = 2;
						else {
							hasH1 = true;
							title = text;
						}
					}
					const id = slugger.slug(text);
					if (level === 2 || level === 3) toc.push({ id, text, level });
					sections.push({ level, id, title: text, content: '' });
					out.push({ t: 'h', level, id, c: inline(node.children, depth + 1) });
					break;
				}
				case 'blockquote':
					out.push({ t: 'bq', c: blocks(node.children, depth + 1) });
					break;
				case 'list':
					out.push({
						t: node.ordered ? 'ol' : 'ul',
						start:
							node.ordered && node.start && node.start !== 1 ? node.start : undefined,
						c: node.children.map((item) => {
							budget -= 1;
							const kids = blocks(item.children, depth + 1);
							if (typeof item.checked === 'boolean') {
								kids.unshift({ t: 'task', checked: item.checked });
							}
							return { t: 'li', c: kids } satisfies MElement;
						})
					});
					break;
				case 'code':
					out.push({
						t: 'pre',
						lang:
							node.lang && /^[A-Za-z0-9_+-]{1,20}$/.test(node.lang)
								? node.lang
								: undefined,
						c: [node.value]
					});
					break;
				case 'thematicBreak':
					out.push({ t: 'hr' });
					break;
				case 'table': {
					const align = node.align ?? [];
					const rows = node.children.map((row, i) => cells(row, i === 0, align));
					out.push({ t: 'table', c: rows });
					break;
				}
				case 'footnoteDefinition': {
					const n = footnotes.get(node.identifier) ?? footnotes.size + 1;
					footnotes.set(node.identifier, n);
					out.push({
						t: 'p',
						c: [
							`[${n}] `,
							...blocks(node.children, depth + 1).flatMap((b) =>
								typeof b !== 'string' && b.t === 'p' ? (b.c ?? []) : [b]
							)
						]
					});
					break;
				}
				// raw HTML and definitions never render
				case 'html':
				case 'definition':
				case 'yaml':
					break;
				default: {
					const text = textOf(node);
					if (text) out.push({ t: 'p', c: [text] });
				}
			}
		}
		return out;
	}

	const nodes = blocks((root as Parent).children as Content[], 0);
	const fallback = ctx.path.split('/').pop()?.replace(/\.md$/, '') ?? '';
	return { title: title || fallback, hasH1, nodes, toc, sections };
}

export function searchSections(
	route: string,
	page: Pick<RenderedPage, 'title' | 'sections'>
): SearchSection[] {
	const out: SearchSection[] = [
		{ id: route, title: page.title, titles: [], level: 1, content: '' }
	];
	const trail: { level: number; title: string }[] = [];
	for (const section of page.sections) {
		while (trail.length && trail[trail.length - 1]!.level >= section.level) trail.pop();
		if (section.level === 1) {
			out[0]!.content = section.content;
			continue;
		}
		const titles = [page.title, ...trail.map((t) => t.title)];
		trail.push({ level: section.level, title: section.title });
		out.push({
			id: `${route}#${section.id}`,
			title: section.title,
			titles,
			level: section.level,
			content: section.content
		});
	}
	return out;
}
