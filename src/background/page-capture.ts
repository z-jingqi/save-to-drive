export type PageCaptureFormat = 'html' | 'markdown';

export interface PageCaptureResult {
  url: string;
  title: string;
  content: string;
}

export async function capturePage(tabId: number, format: PageCaptureFormat): Promise<PageCaptureResult> {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: capturePageInTab,
    args: [format],
  });
  if (!result?.result) throw new Error('Unable to capture this page');
  return result.result;
}

function capturePageInTab(format: PageCaptureFormat): PageCaptureResult {
  const pageUrl = location.href;
  const pageTitle = document.title || location.hostname || 'page';

  function buildHtmlSnapshot(): string {
    const clone = document.documentElement.cloneNode(true) as HTMLElement;
    sanitizeClone(clone);
    pruneNuisanceElements(clone);
    pruneLowValueContainers(clone);

    const readableRoot = pickReadableRoot(clone.querySelector('body') ?? clone);
    const html = document.implementation.createHTMLDocument(pageTitle);
    const head = html.head;
    copyCleanHead(clone, head);

    const main = html.createElement('main');
    main.setAttribute('data-save-to-drive-clean-article', 'true');
    main.appendChild(html.importNode(readableRoot, true));
    html.body.appendChild(main);

    const source = html.createElement('p');
    source.setAttribute('data-save-to-drive-source', 'true');
    const link = html.createElement('a');
    link.href = pageUrl;
    link.textContent = pageUrl;
    source.append('Source: ', link);
    html.body.insertBefore(source, html.body.firstChild);

    const doctype = document.doctype ? `<!DOCTYPE ${document.doctype.name}>` : '<!DOCTYPE html>';
    return `${doctype}\n${html.documentElement.outerHTML}`;
  }

  function buildMarkdown(): string {
    const clone = document.body.cloneNode(true) as HTMLElement;
    sanitizeClone(clone);
    pruneNuisanceElements(clone);
    pruneLowValueContainers(clone);
    const root = pickReadableRoot(clone);
    const body = nodeToMarkdown(root).replace(/\n{3,}/g, '\n\n').trim();
    return `# ${escapeMarkdown(pageTitle)}\n\nSource: ${pageUrl}\n\n${body}\n`;
  }

  function sanitizeClone(root: HTMLElement): void {
    root.querySelectorAll('script,link[rel="preload"],link[rel="modulepreload"]').forEach(node => node.remove());
    root.querySelectorAll('*').forEach(el => {
      for (const attr of [...el.attributes]) {
        if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
        if (attr.name === 'srcset' && el.tagName.toLowerCase() !== 'img') el.removeAttribute(attr.name);
      }
    });
  }

  function copyCleanHead(sourceRoot: HTMLElement, targetHead: HTMLHeadElement): void {
    const base = document.createElement('base');
    base.href = pageUrl;
    targetHead.appendChild(base);

    const charset = document.createElement('meta');
    charset.setAttribute('charset', 'UTF-8');
    targetHead.appendChild(charset);

    const title = document.createElement('title');
    title.textContent = pageTitle;
    targetHead.appendChild(title);

    sourceRoot.querySelectorAll('head meta[name="viewport"], head meta[name="color-scheme"], head link[rel~="stylesheet"], head style')
      .forEach(node => targetHead.appendChild(document.importNode(node, true)));
  }

  function pruneNuisanceElements(root: HTMLElement): void {
    const selectors = [
      'script',
      'noscript',
      'template',
      'iframe[src*="doubleclick" i]',
      'iframe[src*="googlesyndication" i]',
      'iframe[src*="adservice" i]',
      '[hidden]',
      '[aria-hidden="true"]',
      '[inert]',
      '[data-nosnippet]',
      '[role="dialog"]',
      '[role="alertdialog"]',
      '[role="banner"]',
      '[role="contentinfo"]',
      '[role="navigation"]',
      'nav',
      'footer',
      'aside',
      'form[role="search"]',
      'form[action*="subscribe" i]',
      'form[action*="newsletter" i]',
    ];
    root.querySelectorAll(selectors.join(',')).forEach(node => node.remove());
    root.querySelectorAll('*').forEach(node => {
      if (node instanceof HTMLElement && isLikelyNuisance(node)) {
        node.remove();
      }
    });
  }

  function isLikelyNuisance(el: HTMLElement): boolean {
    const marker = [
      el.id,
      el.className,
      el.getAttribute('role'),
      el.getAttribute('aria-label'),
      el.getAttribute('data-testid'),
      el.getAttribute('data-test-id'),
      el.getAttribute('data-component'),
      el.getAttribute('data-module'),
    ].filter(Boolean).join(' ');
    const noisyName = /(^|[-_\s])(ad|ads|advert|advertisement|sponsor|sponsored|promo|promoted|outbrain|taboola|newsletter|subscribe|cookie|consent|gdpr|privacy|paywall|modal|popup|overlay|breadcrumb|sidebar|toolbar|widget|related|recommend|recommendation|popular|trending|share|social|comment|comments|signin|signup|login)([-_\s]|$)/i;
    if (noisyName.test(marker)) return true;

    const style = el.getAttribute('style') ?? '';
    if (/position\s*:\s*fixed/i.test(style) && /z-index\s*:\s*\d{3,}/i.test(style)) return true;
    if (/display\s*:\s*none/i.test(style) || /visibility\s*:\s*hidden/i.test(style)) return true;
    return false;
  }

  function pruneLowValueContainers(root: HTMLElement): void {
    const containers = [...root.querySelectorAll<HTMLElement>('div,section,aside,header,footer')]
      .sort((a, b) => depth(b) - depth(a));
    for (const el of containers) {
      if (!el.parentElement || isReadableContainer(el)) continue;
      const textLength = normalizeText(el.textContent ?? '').length;
      const linkTextLength = [...el.querySelectorAll('a')]
        .map(link => normalizeText(link.textContent ?? ''))
        .join(' ')
        .length;
      const mediaCount = el.querySelectorAll('img,video,figure,picture').length;
      const formControlCount = el.querySelectorAll('button,input,select,textarea').length;
      const linkRatio = linkTextLength / Math.max(textLength, 1);

      if (textLength < 40 && mediaCount === 0 && formControlCount > 0) el.remove();
      else if (textLength < 80 && linkRatio > 0.75 && mediaCount === 0) el.remove();
    }
  }

  function isReadableContainer(el: HTMLElement): boolean {
    const tag = el.tagName.toLowerCase();
    if (tag === 'article' || tag === 'main') return true;
    const marker = [el.id, el.className, el.getAttribute('role')].filter(Boolean).join(' ');
    return /(article|post|entry|content|main|story|body|text)/i.test(marker);
  }

  function depth(el: HTMLElement): number {
    let count = 0;
    for (let node: HTMLElement | null = el; node; node = node.parentElement) count += 1;
    return count;
  }

  function pickReadableRoot(root: HTMLElement): HTMLElement {
    const candidates = [
      ...root.querySelectorAll<HTMLElement>('article, main, [role="main"], .article, .post, .entry-content, .post-content, .article-content, .content, #content'),
      root,
    ];
    let best = root;
    let bestScore = scoreReadableRoot(root);
    for (const candidate of candidates) {
      const score = scoreReadableRoot(candidate);
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    return best;
  }

  function scoreReadableRoot(el: HTMLElement): number {
    const text = normalizeText(el.textContent ?? '');
    if (text.length < 120) return text.length;
    const linkText = [...el.querySelectorAll('a')]
      .map(link => normalizeText(link.textContent ?? ''))
      .join(' ');
    const linkRatio = linkText.length / Math.max(text.length, 1);
    const paragraphCount = el.querySelectorAll('p').length;
    const headingCount = el.querySelectorAll('h1,h2,h3').length;
    const mediaCount = el.querySelectorAll('img,video,figure').length;
    return text.length + paragraphCount * 120 + headingCount * 80 + mediaCount * 35 - linkRatio * text.length * 1.5;
  }

  function nodeToMarkdown(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) return normalizeText(node.textContent ?? '');
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();
    if (['script', 'style', 'svg', 'canvas', 'noscript', 'template'].includes(tag)) return '';
    if (isLikelyNuisance(el)) return '';

    const children = () => [...el.childNodes].map(nodeToMarkdown).join('');
    const blockChildren = () => children().trim();

    switch (tag) {
      case 'h1': return `\n# ${blockChildren()}\n\n`;
      case 'h2': return `\n## ${blockChildren()}\n\n`;
      case 'h3': return `\n### ${blockChildren()}\n\n`;
      case 'h4': return `\n#### ${blockChildren()}\n\n`;
      case 'h5': return `\n##### ${blockChildren()}\n\n`;
      case 'h6': return `\n###### ${blockChildren()}\n\n`;
      case 'p': return `\n${blockChildren()}\n\n`;
      case 'br': return '\n';
      case 'strong':
      case 'b': return `**${blockChildren()}**`;
      case 'em':
      case 'i': return `_${blockChildren()}_`;
      case 'code':
        if (el.closest('pre')) return el.textContent ?? '';
        return `\`${(el.textContent ?? '').replace(/`/g, '\\`')}\``;
      case 'pre': return `\n\`\`\`\n${(el.textContent ?? '').replace(/\n+$/g, '')}\n\`\`\`\n\n`;
      case 'a': {
        const text = blockChildren() || el.getAttribute('href') || '';
        const href = el.getAttribute('href');
        return href ? `[${text}](${new URL(href, location.href).href})` : text;
      }
      case 'img': {
        const src = el.getAttribute('src');
        if (!src) return '';
        const alt = el.getAttribute('alt') ?? '';
        return `![${alt}](${new URL(src, location.href).href})`;
      }
      case 'blockquote': {
        const text = blockChildren().split('\n').map(line => `> ${line}`).join('\n');
        return `\n${text}\n\n`;
      }
      case 'ul':
        return `\n${[...el.children].map(child => `- ${nodeToMarkdown(child).trim()}`).join('\n')}\n\n`;
      case 'ol':
        return `\n${[...el.children].map((child, index) => `${index + 1}. ${nodeToMarkdown(child).trim()}`).join('\n')}\n\n`;
      case 'li': return blockChildren();
      case 'table': return tableToMarkdown(el);
      case 'thead':
      case 'tbody':
      case 'tr':
      case 'td':
      case 'th':
        return blockChildren();
      default:
        if (['div', 'section', 'article', 'main', 'header', 'footer', 'nav'].includes(tag)) {
          return `\n${children()}\n`;
        }
        return children();
    }
  }

  function tableToMarkdown(table: HTMLElement): string {
    const rows = [...table.querySelectorAll('tr')]
      .map(row => [...row.children].map(cell => normalizeText(cell.textContent ?? '').replace(/\|/g, '\\|')))
      .filter(row => row.length > 0);
    if (rows.length === 0) return '';
    const width = Math.max(...rows.map(row => row.length));
    const normalized = rows.map(row => [...row, ...Array(width - row.length).fill('')]);
    const header = normalized[0];
    const separator = Array(width).fill('---');
    const body = normalized.slice(1);
    return `\n| ${header.join(' | ')} |\n| ${separator.join(' | ')} |\n${body.map(row => `| ${row.join(' | ')} |`).join('\n')}\n\n`;
  }

  function normalizeText(text: string): string {
    return text.replace(/\s+/g, ' ');
  }

  function escapeMarkdown(text: string): string {
    return text.replace(/[\\`*_{}[\]()#+\-.!|>]/g, '\\$&');
  }

  return {
    url: pageUrl,
    title: pageTitle,
    content: format === 'html' ? buildHtmlSnapshot() : buildMarkdown(),
  };
}
