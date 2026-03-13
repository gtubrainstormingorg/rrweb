import type {
  idNodeMap,
  MaskInputFn,
  MaskInputOptions,
  nodeMetaMap,
  IMirror,
  serializedNodeWithId,
  serializedNode,
  documentNode,
  documentTypeNode,
  textNode,
  elementNode,
} from './types';
import dom from '@howdygo/rrweb-utils';
import { NodeType } from './types';

export function isElement(n: Node): n is Element {
  return n.nodeType === n.ELEMENT_NODE;
}

export function isShadowRoot(n: Node): n is ShadowRoot {
  const hostEl: Element | null =
    // anchor and textarea elements also have a `host` property
    // but only shadow roots have a `mode` property
    (n && 'host' in n && 'mode' in n && dom.host(n as ShadowRoot)) || null;
  return Boolean(
    hostEl && 'shadowRoot' in hostEl && dom.shadowRoot(hostEl) === n,
  );
}

/**
 * To fix the issue https://github.com/rrweb-io/rrweb/issues/933.
 * Some websites use polyfilled shadow dom and this function is used to detect this situation.
 */
export function isNativeShadowDom(shadowRoot: ShadowRoot): boolean {
  return Object.prototype.toString.call(shadowRoot) === '[object ShadowRoot]';
}

/**
 * Browsers sometimes destructively modify the css rules they receive.
 * This function tries to rectify the modifications the browser made to make it more cross platform compatible.
 * @param cssText - output of `CSSStyleRule.cssText`
 * @returns `cssText` with browser inconsistencies fixed.
 */
function fixBrowserCompatibilityIssuesInCSS(cssText: string): string {
  /**
   * Chrome outputs `-webkit-background-clip` as `background-clip` in `CSSStyleRule.cssText`.
   * But then Chrome ignores `background-clip` as css input.
   * Re-introduce `-webkit-background-clip` to fix this issue.
   */
  if (
    cssText.includes(' background-clip: text;') &&
    !cssText.includes(' -webkit-background-clip: text;')
  ) {
    cssText = cssText.replace(
      /\sbackground-clip:\s*text;/g,
      ' -webkit-background-clip: text; background-clip: text;',
    );
  }
  return cssText;
}

// Remove this declaration once typescript has added `CSSImportRule.supportsText` to the lib.
declare interface CSSImportRule extends CSSRule {
  readonly href: string;
  readonly layerName: string | null;
  readonly media: MediaList;
  readonly styleSheet: CSSStyleSheet;
  /**
   * experimental API, currently only supported in firefox
   * https://developer.mozilla.org/en-US/docs/Web/API/CSSImportRule/supportsText
   */
  readonly supportsText?: string | null;
}

/**
 * Browsers sometimes incorrectly escape `@import` on `.cssText` statements.
 * This function tries to correct the escaping.
 * more info: https://bugs.chromium.org/p/chromium/issues/detail?id=1472259
 * @param cssImportRule
 * @returns `cssText` with browser inconsistencies fixed, or null if not applicable.
 */
export function escapeImportStatement(rule: CSSImportRule): string {
  const { cssText } = rule;
  if (cssText.split('"').length < 3) return cssText;

  const statement = ['@import', `url(${JSON.stringify(rule.href)})`];
  if (rule.layerName === '') {
    statement.push(`layer`);
  } else if (rule.layerName) {
    statement.push(`layer(${rule.layerName})`);
  }
  if (rule.supportsText) {
    statement.push(`supports(${rule.supportsText})`);
  }
  if (rule.media.length) {
    statement.push(rule.media.mediaText);
  }
  return statement.join(' ') + ';';
}

/*
 * serialize the css rules from the .sheet property
 * for <link rel="stylesheet"> elements, this is the only way of getting the rules without a FETCH
 * for <style> elements, this is less preferable to looking at childNodes[0].textContent
 * (which will include vendor prefixed rules which may not be used or visible to the recorded browser,
 * but which might be needed by the replayer browser)
 * however, at snapshot time, we don't know whether the style element has suffered
 * any programmatic manipulation prior to the snapshot, in which case the .sheet would be more up to date
 */
export function stringifyStylesheet(s: CSSStyleSheet): string | null {
  try {
    const rules = s.rules || s.cssRules;
    if (!rules) {
      return null;
    }
    let sheetHref = s.href;
    if (!sheetHref && s.ownerNode && s.ownerNode.ownerDocument) {
      // an inline <style> element
      sheetHref = s.ownerNode.ownerDocument.location.href;
    }
    const stringifiedRules = Array.from(rules, (rule: CSSRule) =>
      stringifyRule(rule, sheetHref),
    ).join('');
    return fixBrowserCompatibilityIssuesInCSS(stringifiedRules);
  } catch (error) {
    return null;
  }
}

export function stringifyRule(rule: CSSRule, sheetHref: string | null): string {
  if (isCSSImportRule(rule)) {
    let importStringified;
    try {
      importStringified =
        // for same-origin stylesheets,
        // we can access the imported stylesheet rules directly
        stringifyStylesheet(rule.styleSheet) ||
        // work around browser issues with the raw string `@import url(...)` statement
        escapeImportStatement(rule);
    } catch (error) {
      importStringified = rule.cssText;
    }
    if (rule.styleSheet.href) {
      // url()s within the imported stylesheet are relative to _that_ sheet's href
      return absolutifyURLs(importStringified, rule.styleSheet.href);
    }
    return importStringified;
  } else {
    let ruleStringified = rule.cssText;
    if (isCSSStyleRule(rule) && rule.selectorText.includes(':')) {
      // Safari does not escape selectors with : properly
      // see https://bugs.webkit.org/show_bug.cgi?id=184604
      ruleStringified = fixSafariColons(ruleStringified);
    }
    if (sheetHref) {
      return absolutifyURLs(ruleStringified, sheetHref);
    }
    return ruleStringified;
  }
}

export function fixSafariColons(cssStringified: string): string {
  // Replace e.g. [aa:bb] with [aa\\:bb]
  const regex = /(\[(?:[\w-]+)[^\\])(:(?:[\w-]+)\])/gm;
  return cssStringified.replace(regex, '$1\\$2');
}

export function isCSSImportRule(rule: CSSRule): rule is CSSImportRule {
  return 'styleSheet' in rule;
}

export function isCSSStyleRule(rule: CSSRule): rule is CSSStyleRule {
  return 'selectorText' in rule;
}

export class Mirror implements IMirror<Node> {
  private idNodeMap: idNodeMap = new Map();
  private nodeMetaMap: nodeMetaMap = new WeakMap();

  getId(n: Node | undefined | null): number {
    if (!n) return -1;

    const id = this.getMeta(n)?.id;

    // if n is not a serialized Node, use -1 as its id.
    return id ?? -1;
  }

  getNode(id: number): Node | null {
    return this.idNodeMap.get(id) || null;
  }

  getIds(): number[] {
    return Array.from(this.idNodeMap.keys());
  }

  getMeta(n: Node): serializedNodeWithId | null {
    return this.nodeMetaMap.get(n) || null;
  }

  // removes the node from idNodeMap
  // doesn't remove the node from nodeMetaMap
  removeNodeFromMap(n: Node) {
    const id = this.getId(n);
    this.idNodeMap.delete(id);

    if (n.childNodes) {
      n.childNodes.forEach((childNode) =>
        this.removeNodeFromMap(childNode as unknown as Node),
      );
    }
  }
  has(id: number): boolean {
    return this.idNodeMap.has(id);
  }

  hasNode(node: Node): boolean {
    return this.nodeMetaMap.has(node);
  }

  add(n: Node, meta: serializedNodeWithId) {
    const id = meta.id;
    this.idNodeMap.set(id, n);
    this.nodeMetaMap.set(n, meta);
  }

  replace(id: number, n: Node) {
    const oldNode = this.getNode(id);
    if (oldNode) {
      const meta = this.nodeMetaMap.get(oldNode);
      if (meta) this.nodeMetaMap.set(n, meta);
    }
    this.idNodeMap.set(id, n);
  }

  reset() {
    this.idNodeMap = new Map();
    this.nodeMetaMap = new WeakMap();
  }
}

export function createMirror(): Mirror {
  return new Mirror();
}

export function maskInputValue({
  element,
  maskInputOptions,
  tagName,
  type,
  value,
  maskInputFn,
}: {
  element: HTMLElement;
  maskInputOptions: MaskInputOptions;
  tagName: string;
  type: string | null;
  value: string | null;
  maskInputFn?: MaskInputFn;
}): string {
  let text = value || '';
  const actualType = type && toLowerCase(type);

  if (
    maskInputOptions[tagName.toLowerCase() as keyof MaskInputOptions] ||
    (actualType && maskInputOptions[actualType as keyof MaskInputOptions])
  ) {
    if (maskInputFn) {
      text = maskInputFn(text, element);
    } else {
      text = '*'.repeat(text.length);
    }
  }
  return text;
}

export function toLowerCase<T extends string>(str: T): Lowercase<T> {
  return str.toLowerCase() as unknown as Lowercase<T>;
}

const ORIGINAL_ATTRIBUTE_NAME = '__rrweb_original__';
type PatchedGetImageData = {
  [ORIGINAL_ATTRIBUTE_NAME]: CanvasImageData['getImageData'];
} & CanvasImageData['getImageData'];

export function is2DCanvasBlank(canvas: HTMLCanvasElement): boolean {
  const ctx = canvas.getContext('2d');
  if (!ctx) return true;

  const chunkSize = 50;

  // get chunks of the canvas and check if it is blank
  for (let x = 0; x < canvas.width; x += chunkSize) {
    for (let y = 0; y < canvas.height; y += chunkSize) {
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const getImageData = ctx.getImageData as PatchedGetImageData;
      const originalGetImageData =
        ORIGINAL_ATTRIBUTE_NAME in getImageData
          ? getImageData[ORIGINAL_ATTRIBUTE_NAME]
          : getImageData;
      // by getting the canvas in chunks we avoid an expensive
      // `getImageData` call that retrieves everything
      // even if we can already tell from the first chunk(s) that
      // the canvas isn't blank
      const pixelBuffer = new Uint32Array(
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access
        originalGetImageData.call(
          ctx,
          x,
          y,
          Math.min(chunkSize, canvas.width - x),
          Math.min(chunkSize, canvas.height - y),
        ).data.buffer,
      );
      if (pixelBuffer.some((pixel) => pixel !== 0)) return false;
    }
  }
  return true;
}

export function isNodeMetaEqual(a: serializedNode, b: serializedNode): boolean {
  if (!a || !b || a.type !== b.type) return false;
  if (a.type === NodeType.Document)
    return a.compatMode === (b as documentNode).compatMode;
  else if (a.type === NodeType.DocumentType)
    return (
      a.name === (b as documentTypeNode).name &&
      a.publicId === (b as documentTypeNode).publicId &&
      a.systemId === (b as documentTypeNode).systemId
    );
  else if (
    a.type === NodeType.Comment ||
    a.type === NodeType.Text ||
    a.type === NodeType.CDATA
  )
    return a.textContent === (b as textNode).textContent;
  else if (a.type === NodeType.Element)
    return (
      a.tagName === (b as elementNode).tagName &&
      JSON.stringify(a.attributes) ===
        JSON.stringify((b as elementNode).attributes) &&
      a.isSVG === (b as elementNode).isSVG &&
      a.needBlock === (b as elementNode).needBlock
    );
  return false;
}

/**
 * Get the type of an input element.
 * This takes care of the case where a password input is changed to a text input.
 * In this case, we continue to consider this of type password, in order to avoid leaking sensitive data
 * where passwords should be masked.
 */
export function getInputType(element: HTMLElement): Lowercase<string> | null {
  // when omitting the type of input element(e.g. <input />), the type is treated as text
  const type = (element as HTMLInputElement).type;

  return element.hasAttribute('data-rr-is-password')
    ? 'password'
    : type
    ? // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
      toLowerCase(type)
    : null;
}

/**
 * Extracts the file extension from an a path, considering search parameters and fragments.
 * @param path - Path to file
 * @param baseURL - [optional] Base URL of the page, used to resolve relative paths. Defaults to current page URL.
 */
export function extractFileExtension(
  path: string,
  baseURL?: string,
): string | null {
  let url;
  try {
    url = new URL(path, baseURL ?? window.location.href);
  } catch (err) {
    return null;
  }
  const regex = /\.([0-9a-z]+)(?:$)/i;
  const match = url.pathname.match(regex);
  return match?.[1] ?? null;
}

function extractOrigin(url: string): string {
  let origin = '';
  if (url.indexOf('//') > -1) {
    origin = url.split('/').slice(0, 3).join('/');
  } else {
    origin = url.split('/')[0];
  }
  origin = origin.split('?')[0];
  return origin;
}

const URL_IN_CSS_REF = /url\((?:(')([^']*)'|(")(.*?)"|([^)]*))\)/gm;
const URL_PROTOCOL_MATCH = /^(?:[a-z+]+:)?\/\//i;
const URL_WWW_MATCH = /^www\..*/i;
const DATA_URI = /^(data:)([^,]*),(.*)/i;
export function absolutifyURLs(cssText: string | null, href: string): string {
  return (cssText || '').replace(
    URL_IN_CSS_REF,
    (
      origin: string,
      quote1: string,
      path1: string,
      quote2: string,
      path2: string,
      path3: string,
    ) => {
      const filePath = path1 || path2 || path3;
      const maybeQuote = quote1 || quote2 || '';
      if (!filePath) {
        return origin;
      }
      if (URL_PROTOCOL_MATCH.test(filePath) || URL_WWW_MATCH.test(filePath)) {
        return `url(${maybeQuote}${filePath}${maybeQuote})`;
      }
      if (DATA_URI.test(filePath)) {
        return `url(${maybeQuote}${filePath}${maybeQuote})`;
      }
      if (filePath[0] === '/') {
        return `url(${maybeQuote}${
          extractOrigin(href) + filePath
        }${maybeQuote})`;
      }
      const stack = href.split('/');
      const parts = filePath.split('/');
      stack.pop();
      for (const part of parts) {
        if (part === '.') {
          continue;
        } else if (part === '..') {
          stack.pop();
        } else {
          stack.push(part);
        }
      }
      return `url(${maybeQuote}${stack.join('/')}${maybeQuote})`;
    },
  );
}

/**
 * Intention is to normalize by remove spaces, semicolons and CSS comments
 * so that we can compare css as authored vs. output of stringifyStylesheet
 */
export function normalizeCssString(cssText: string): string {
  return cssText.replace(/(\/\*[^*]*\*\/)|[\s;]/g, '');
}

/**
 * Maps the output of stringifyStylesheet to individual text nodes of a <style> element
 * performance is not considered as this is anticipated to be very much an edge case
 * (javascript is needed to add extra text nodes to a <style>)
 */
export function splitCssText(
  cssText: string,
  style: HTMLStyleElement,
): string[] {
  const childNodes = Array.from(style.childNodes);
  const splits: string[] = [];
  if (childNodes.length > 1 && cssText && typeof cssText === 'string') {
    const cssTextNorm = normalizeCssString(cssText);
    for (let i = 1; i < childNodes.length; i++) {
      if (
        childNodes[i].textContent &&
        typeof childNodes[i].textContent === 'string'
      ) {
        const textContentNorm = normalizeCssString(childNodes[i].textContent!);
        for (let j = 3; j < textContentNorm.length; j++) {
          // find a  substring that appears only once
          const bit = textContentNorm.substring(0, j);
          if (cssTextNorm.split(bit).length === 2) {
            const splitNorm = cssTextNorm.indexOf(bit);
            // find the split point in the original text
            for (let k = splitNorm; k < cssText.length; k++) {
              if (
                normalizeCssString(cssText.substring(0, k)).length === splitNorm
              ) {
                splits.push(cssText.substring(0, k));
                cssText = cssText.substring(k);
                break;
              }
            }
            break;
          }
        }
      }
    }
  }
  splits.push(cssText); // either the full thing if no splits were found, or the last split
  return splits;
}

export function markCssSplits(
  cssText: string,
  style: HTMLStyleElement,
): string {
  return splitCssText(cssText, style).join('/* rr_split */');
}

/**
 * Remove CSS comments while protecting url() content from being corrupted.
 */
export function removeCommentsFromCss(cssString: string): string {
  // Protect url() content by temporarily replacing them
  const urlPlaceholders: string[] = [];
  const protectedCss = cssString.replace(/url\((['"]?)(.*?)\1\)/g, (match) => {
    urlPlaceholders.push(match);
    return `__URL_PLACEHOLDER_${urlPlaceholders.length - 1}__`;
  });

  // Remove comments safely without interfering with url() content
  const cssWithoutComments = protectedCss.replace(/\/\*[\s\S]*?\*\//g, '');

  // Restore the protected url() content
  const restoredCss = cssWithoutComments.replace(
    /__URL_PLACEHOLDER_(\d+)__/g,
    (_, index) => urlPlaceholders[Number(index)],
  );

  return restoredCss;
}

/**
 * Fix malformed linear-gradient syntax that uses `text` instead of
 * the correct `-webkit-background-clip: text` declaration.
 */
export function fixLinearGradients(cssString: string): string {
  return cssString.replace(
    /linear-gradient\(([^;]+?)\)\s+text;/g,
    'linear-gradient($1); -webkit-background-clip: text;',
  );
}

/**
 * Get unique URL matches from CSS url() patterns.
 * Matches url(...) with support for nested brackets, quoted and unquoted URLs.
 */
export function getMatchesFromCss(cssString: string) {
  const matches = [
    ...cssString.matchAll(
      /(?<!@namespace[^;]*)(url\(['"]?)(?:[^)(]|\((?:[^)(]|\((?:[^)(]|\([^)(]*\))*\))*\))*?(['"]?\))/g,
    ),
  ];

  const results = matches
    .map((match) => ({
      match: match[0],
      prefix: match[1],
      postfix: match[2],
      url: match[0].slice(match[1].length, -match[2].length),
    }))
    .map((result) => {
      // Remove double Empiraa urls
      const urls = [...result.url.matchAll(/(\shttps?:\/\/[^\s]+)/g)];
      if (urls && urls[urls.length - 1] && urls[urls.length - 1][0]) {
        result.url = urls[urls.length - 1][0].slice(1);
      }
      return result;
    })
    .map((result) => {
      // Remove whitespace from start and end of urls
      result.url = result.url.trim();
      return result;
    })
    // Filter out local SVG gradients and other url references starting with #
    .filter((result) => !result.url.startsWith('#'));

  // Reduce to uniqueResults only
  const uniqueResults = [
    ...results
      .reduce((map, { match, prefix, postfix, url }) => {
        return map.set(`${match}-${prefix}-${postfix}-${url}`, {
          match,
          prefix,
          postfix,
          url,
        });
      }, new Map<string, { match: string; prefix: string; postfix: string; url: string }>())
      .values(),
  ];

  // Reduce to set of unique urls with length greater than 0
  const uniqueUrls = [
    ...new Set(
      uniqueResults.map((result) => result.url).filter((u) => u.length > 0),
    ),
  ];

  return { uniqueResults, uniqueUrls };
}

/**
 * Extract URLs from an image-set() argument string.
 */
export function extractUrlsFromImageSetString(
  imageSetString: string,
): string[] {
  const matches = [
    ...imageSetString.matchAll(
      /(?<!\()\s*(['"])([^'"\s,)]+)\1(?:\s+[0-9.]+[xw])?(?:\s+type\([^)]*\))?/g,
    ),
  ];
  return matches.map((match) => match[2]);
}

/**
 * Get image-set() matches from CSS, extracting the URLs within each.
 */
export function getMatchesFromImageSet(cssString: string) {
  const matches = [
    ...cssString.matchAll(
      /(?:-webkit-)?image-set\(\s*((?:[^()]+|\([^()]*\))*)\s*\)/g,
    ),
  ];
  return matches
    .map((match) => ({
      match: match[0],
      urls: extractUrlsFromImageSetString(match[1]),
    }))
    .filter((m) => m.urls.length > 0);
}

/**
 * Resolve a (potentially relative) URL against a base URL.
 */
export function resolveUrl(url: string, baseUrl: string): string {
  if (!url || url.startsWith('data:') || url.startsWith('#')) {
    return url;
  }
  if (URL_PROTOCOL_MATCH.test(url) || URL_WWW_MATCH.test(url)) {
    return url;
  }
  if (url[0] === '/') {
    return extractOrigin(baseUrl) + url;
  }
  const stack = baseUrl.split('/');
  const parts = url.split('/');
  stack.pop();
  for (const part of parts) {
    if (part === '.') {
      continue;
    } else if (part === '..') {
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  return stack.join('/');
}

/**
 * Process CSS text by removing comments, fixing gradients, resolving @import
 * url() references by fetching and inlining the imported CSS recursively,
 * and absolutifying all remaining asset URLs.
 *
 * This matches the processing pipeline used by the extension's
 * _cacheCssAssetsAndUpdateUrls function.
 */
export async function processCssText(
  cssText: string,
  baseUrl: string,
): Promise<string> {
  cssText = removeCommentsFromCss(cssText);
  cssText = fixLinearGradients(cssText);

  // Get image sets and regular CSS URLs
  const imageSets = getMatchesFromImageSet(cssText);
  const { uniqueUrls, uniqueResults } = getMatchesFromCss(cssText);

  // Extract all URLs (both from image sets and regular URLs)
  const allUrls = [
    ...uniqueUrls,
    ...imageSets.flatMap((imageSet) => imageSet.urls),
  ];

  // Get all replacements in parallel
  const replacements = await Promise.all(
    allUrls.map(async (url) => {
      if (url.match(/\.css(\?.*)?$/i)) {
        // If .css extension then fetch and process recursively
        const srcUrl = resolveUrl(url, baseUrl);
        try {
          const cssFile = await fetch(srcUrl).then((res) => res.text());
          // Recursively process the CSS to handle nested @imports and URLs
          const processedCss = await processCssText(cssFile, srcUrl);
          return { originalUrl: url, newUrl: srcUrl, inlineCss: processedCss };
        } catch {
          // On failure, just absolutify the URL
          return { originalUrl: url, newUrl: srcUrl };
        }
      } else {
        // For other assets, absolutify the URL
        const resolvedUrl = resolveUrl(url, baseUrl);
        return { originalUrl: url, newUrl: resolvedUrl };
      }
    }),
  );

  // Handle replacements for regular URLs
  for (const result of uniqueResults) {
    const { prefix, postfix, match, url } = result;
    const replacement = replacements.find((r) => r.originalUrl === url);
    if (!replacement) continue;

    const { newUrl } = replacement;
    const inlineCss =
      'inlineCss' in replacement ? replacement.inlineCss : undefined;

    if (inlineCss !== undefined) {
      // For .css URLs inside @import, inline the CSS content
      const escapedMatch = match.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const importPattern = new RegExp(`@import\\s*${escapedMatch}\\s*;?`);
      if (importPattern.test(cssText)) {
        cssText = cssText.replace(importPattern, inlineCss);
      } else if (newUrl) {
        // Not an @import, just absolutify
        cssText = cssText.replaceAll(match, `${prefix}${newUrl}${postfix}`);
      }
    } else if (newUrl) {
      cssText = cssText.replaceAll(match, `${prefix}${newUrl}${postfix}`);
    }
  }

  // Handle replacements for image set URLs
  for (const { match, urls } of imageSets) {
    let newImageSet = match;
    for (const originalUrl of urls) {
      const replacement = replacements.find(
        (r) => r.originalUrl === originalUrl,
      );
      if (replacement && replacement.newUrl) {
        newImageSet = newImageSet.replace(originalUrl, replacement.newUrl);
      }
    }
    cssText = cssText.replace(match, newImageSet);
  }

  return cssText;
}
