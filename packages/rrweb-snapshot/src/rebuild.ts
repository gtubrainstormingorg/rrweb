import { mediaSelectorPlugin, pseudoClassPlugin } from './css';
import {
  type serializedNodeWithId,
  type serializedElementNodeWithId,
  type serializedTextNodeWithId,
  NodeType,
  type tagMap,
  type elementNode,
  type BuildCache,
  type legacyAttributes,
} from './types';
import { isElement, Mirror, isNodeMetaEqual } from './utils';
import postcss from 'postcss';
import postcssSafeParser from 'howdygo-postcss-safe-parser';

const tagMap: tagMap = {
  script: 'noscript',
  // camel case svg element tag names
  altglyph: 'altGlyph',
  altglyphdef: 'altGlyphDef',
  altglyphitem: 'altGlyphItem',
  animatecolor: 'animateColor',
  animatemotion: 'animateMotion',
  animatetransform: 'animateTransform',
  clippath: 'clipPath',
  feblend: 'feBlend',
  fecolormatrix: 'feColorMatrix',
  fecomponenttransfer: 'feComponentTransfer',
  fecomposite: 'feComposite',
  feconvolvematrix: 'feConvolveMatrix',
  fediffuselighting: 'feDiffuseLighting',
  fedisplacementmap: 'feDisplacementMap',
  fedistantlight: 'feDistantLight',
  fedropshadow: 'feDropShadow',
  feflood: 'feFlood',
  fefunca: 'feFuncA',
  fefuncb: 'feFuncB',
  fefuncg: 'feFuncG',
  fefuncr: 'feFuncR',
  fegaussianblur: 'feGaussianBlur',
  feimage: 'feImage',
  femerge: 'feMerge',
  femergenode: 'feMergeNode',
  femorphology: 'feMorphology',
  feoffset: 'feOffset',
  fepointlight: 'fePointLight',
  fespecularlighting: 'feSpecularLighting',
  fespotlight: 'feSpotLight',
  fetile: 'feTile',
  feturbulence: 'feTurbulence',
  foreignobject: 'foreignObject',
  glyphref: 'glyphRef',
  lineargradient: 'linearGradient',
  radialgradient: 'radialGradient',
};

// Global cache for canvas data URL images to avoid flicker during seeking/replay
// The cache uses the data URL as key, so identical images are reused
const canvasDataURLImageCache: Map<string, HTMLImageElement> = new Map();

/**
 * Get or create a cached image for a data URL.
 * If the image is already cached and loaded, it can be drawn synchronously.
 */
function getCachedCanvasImage(dataURL: string): HTMLImageElement {
  let image = canvasDataURLImageCache.get(dataURL);
  if (!image) {
    image = new Image();
    // Store in cache before setting src so subsequent calls get the same image
    canvasDataURLImageCache.set(dataURL, image);
    image.src = dataURL;
  }
  return image;
}

/**
 * Preload a canvas data URL image into the cache.
 * Returns a promise that resolves when the image is loaded.
 */
export function preloadCanvasImage(dataURL: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const image = getCachedCanvasImage(dataURL);
    if (image.complete && image.naturalWidth > 0) {
      resolve();
    } else {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error(`Failed to preload canvas image`));
    }
  });
}

/**
 * Extract all canvas rr_dataURL values from a serialized node tree.
 * Used for preloading canvas images before replay.
 */
export function extractCanvasDataURLs(node: serializedNodeWithId): string[] {
  const dataURLs: string[] = [];

  function walk(n: serializedNodeWithId) {
    if (n.type === NodeType.Element) {
      const el = n as serializedElementNodeWithId;
      if (el.tagName === 'canvas' && el.attributes.rr_dataURL) {
        dataURLs.push(el.attributes.rr_dataURL as string);
      }
      if (el.childNodes) {
        el.childNodes.forEach(walk);
      }
    }
  }

  walk(node);
  return dataURLs;
}

/**
 * Preload all canvas images from a serialized node tree.
 * Call this before replay to eliminate canvas flicker.
 */
export function preloadAllCanvasImages(
  node: serializedNodeWithId,
): Promise<void[]> {
  const dataURLs = extractCanvasDataURLs(node);
  return Promise.all(dataURLs.map(preloadCanvasImage));
}
function getTagName(n: elementNode): string {
  let tagName = tagMap[n.tagName] ? tagMap[n.tagName] : n.tagName;
  if (tagName === 'link' && n.attributes._cssText) {
    tagName = 'style';
  }
  return tagName;
}

export function adaptCssForReplay(cssText: string, cache: BuildCache): string {
  const cachedStyle = cache?.stylesWithHoverClass.get(cssText);
  if (cachedStyle) return cachedStyle;
  const ast: { css: string } = postcss([
    mediaSelectorPlugin,
    pseudoClassPlugin,
  ]).process(cssText, { parser: postcssSafeParser });
  const result = ast.css;
  cache?.stylesWithHoverClass.set(cssText, result);
  return result;
}

export function createCache(): BuildCache {
  const stylesWithHoverClass: Map<string, string> = new Map();
  return {
    stylesWithHoverClass,
  };
}

/**
 * undo splitCssText/markCssSplits
 * (would move to utils.ts but uses `adaptCssForReplay`)
 */
export function applyCssSplits(
  n: serializedElementNodeWithId,
  cssText: string,
  hackCss: boolean,
  cache: BuildCache,
): void {
  const childTextNodes: serializedTextNodeWithId[] = [];
  for (const scn of n.childNodes) {
    if (scn.type === NodeType.Text) {
      childTextNodes.push(scn);
    }
  }
  const cssTextSplits = cssText.split('/* rr_split */');
  while (
    cssTextSplits.length > 1 &&
    cssTextSplits.length > childTextNodes.length
  ) {
    // unexpected: remerge the last two so that we don't discard any css
    cssTextSplits.splice(-2, 2, cssTextSplits.slice(-2).join(''));
  }
  for (let i = 0; i < childTextNodes.length; i++) {
    const childTextNode = childTextNodes[i];
    const cssTextSection = cssTextSplits[i];
    if (childTextNode && cssTextSection) {
      // id will be assigned when these child nodes are
      // iterated over in buildNodeWithSN
      childTextNode.textContent = hackCss
        ? adaptCssForReplay(cssTextSection, cache)
        : cssTextSection;
    }
  }
}

/**
 * Normally a <style> element has a single textNode containing the rules.
 * During serialization, we bypass this (`styleEl.sheet`) to get the rules the
 * browser sees and serialize this to a special _cssText attribute, blanking
 * out any text nodes. This function reverses that and also handles cases where
 * there were no textNode children present (dynamic css/or a <link> element) as
 * well as multiple textNodes, which need to be repopulated (based on presence of
 * a special `rr_split` marker in case they are modified by subsequent mutations.
 */
export function buildStyleNode(
  n: serializedElementNodeWithId,
  styleEl: HTMLStyleElement, // when inlined, a <link type="stylesheet"> also gets rebuilt as a <style>
  cssText: string,
  options: {
    doc: Document;
    hackCss: boolean;
    cache: BuildCache;
    lazyLoadImages?: boolean;
  },
) {
  const { doc, hackCss, cache } = options;
  if (n.childNodes.length) {
    applyCssSplits(n, cssText, hackCss, cache);
  } else {
    if (hackCss) {
      cssText = adaptCssForReplay(cssText, cache);
    }
    /**
       <link> element or dynamic <style> are serialized without any child nodes
       we create the text node without an ID or presence in mirror as it can't
    */
    styleEl.appendChild(doc.createTextNode(cssText));
  }
}

function buildNode(
  n: serializedNodeWithId,
  options: {
    doc: Document;
    hackCss: boolean;
    cache: BuildCache;
    lazyLoadImages?: boolean;
    /**
     * Set of canvas node IDs that have pending mutations.
     * For these canvases, skip drawing rr_dataURL during rebuild because
     * a canvas mutation will update them to the correct state.
     * Canvases NOT in this set will still draw their rr_dataURL.
     */
    canvasNodeIdsToSkip?: Set<number>;
  },
): Node | null {
  const { doc, hackCss, cache, lazyLoadImages, canvasNodeIdsToSkip } = options;
  switch (n.type) {
    case NodeType.Document:
      return doc.implementation.createDocument(null, '', null);
    case NodeType.DocumentType:
      return doc.implementation.createDocumentType(
        n.name || 'html',
        n.publicId,
        n.systemId,
      );
    case NodeType.Element: {
      const tagName = getTagName(n);
      let node: Element;
      if (n.isSVG) {
        node = doc.createElementNS('http://www.w3.org/2000/svg', tagName);
      } else {
        if (
          // If the tag name is a custom element name
          n.isCustom &&
          // If the browser supports custom elements
          doc.defaultView?.customElements &&
          // If the custom element hasn't been defined yet
          !doc.defaultView.customElements.get(n.tagName)
        )
          doc.defaultView.customElements.define(
            n.tagName,
            class extends doc.defaultView.HTMLElement {},
          );
        node = doc.createElement(tagName);
      }

      if ((tagName === 'iframe' && !n.attributes.src) || !n.attributes.rr_src) {
        // Only set iframe src in Safari (both mobile and desktop) due to Safari-specific nested iframe handling requirements
        const isSafari =
          /Safari/.test(navigator.userAgent) &&
          !/Chrome|Chromium|Edge/.test(navigator.userAgent);
        if (isSafari) {
          node.setAttribute('src', '/iframe/rrweb.html');
        }
      }
      /**
       * Attribute names start with `rr_` are internal attributes added by rrweb.
       * They often overwrite other attributes on the element.
       * We need to parse them last so they can overwrite conflicting attributes.
       */
      const specialAttributes: { [key: string]: string | number } = {};
      // Add lazy loading for images
      if (
        tagName === 'img' &&
        !n.attributes['loading'] &&
        lazyLoadImages === true
      ) {
        node.setAttribute('loading', 'lazy');
      }
      for (const name in n.attributes) {
        if (!Object.prototype.hasOwnProperty.call(n.attributes, name)) {
          continue;
        }
        let value = n.attributes[name];
        if (
          tagName === 'option' &&
          name === 'selected' &&
          (value as legacyAttributes[typeof name]) === false
        ) {
          // legacy fix (TODO: if `value === false` can be generated for other attrs,
          // should we also omit those other attrs from build ?)
          continue;
        }

        // null values mean the attribute was removed
        if (value === null) {
          continue;
        }

        /**
         * Boolean attributes are considered to be true if they're present on the element at all.
         * We should set value to the empty string ("") or the attribute's name, with no leading or trailing whitespace.
         * @see https://developer.mozilla.org/en-US/docs/Web/API/Element/setAttribute#parameters
         */
        if (value === true) value = '';

        if (name.startsWith('rr_')) {
          specialAttributes[name] = value;
          continue;
        }

        if (typeof value !== 'string') {
          // pass
        } else if (tagName === 'style' && name === '_cssText') {
          buildStyleNode(n, node as HTMLStyleElement, value, options);
          continue; // no need to set _cssText as attribute
        } else if (tagName === 'textarea' && name === 'value') {
          // create without an ID or presence in mirror
          node.appendChild(doc.createTextNode(value));
          n.childNodes = []; // value overrides childNodes
          continue;
        }

        try {
          if (n.isSVG && name === 'xlink:href') {
            node.setAttributeNS(
              'http://www.w3.org/1999/xlink',
              name,
              value.toString(),
            );
          } else if (
            name === 'onload' ||
            name === 'onclick' ||
            name.substring(0, 7) === 'onmouse'
          ) {
            // Rename some of the more common atttributes from https://www.w3schools.com/tags/ref_eventattributes.asp
            // as setting them triggers a console.error (which shows up despite the try/catch)
            // Assumption: these attributes are not used to css
            node.setAttribute('_' + name, value.toString());
          } else if (
            tagName === 'meta' &&
            n.attributes['http-equiv'] === 'Content-Security-Policy' &&
            name === 'content'
          ) {
            // If CSP contains style-src and inline-style is disabled, there will be an error "Refused to apply inline style because it violates the following Content Security Policy directive: style-src '*'".
            // And the function insertStyleRules in rrweb replayer will throw an error "Uncaught TypeError: Cannot read property 'insertRule' of null".
            node.setAttribute('csp-content', value.toString());
            continue;
          } else if (
            tagName === 'link' &&
            (n.attributes.rel === 'preload' ||
              n.attributes.rel === 'modulepreload') &&
            n.attributes.as === 'script'
          ) {
            // ignore
          } else if (
            tagName === 'link' &&
            n.attributes.rel === 'prefetch' &&
            typeof n.attributes.href === 'string' &&
            n.attributes.href.endsWith('.js')
          ) {
            // ignore
          } else if (
            tagName === 'img' &&
            n.attributes.srcset &&
            n.attributes.rr_dataURL
          ) {
            // backup original img srcset
            node.setAttribute(
              'rrweb-original-srcset',
              n.attributes.srcset as string,
            );
          } else {
            node.setAttribute(name, value.toString());
          }
        } catch (error) {
          // skip invalid attribute
        }
      }

      for (const name in specialAttributes) {
        const value = specialAttributes[name];
        // handle internal attributes
        if (tagName === 'canvas' && name === 'rr_dataURL') {
          type RRCanvasElement = {
            RRNodeType: NodeType;
            rr_dataURL: string;
          };
          // If the canvas element is created in RRDom runtime (seeking to a time point), the canvas context isn't supported. So the data has to be stored and not handled until diff process. https://github.com/rrweb-io/rrweb/pull/944
          if ((node as unknown as RRCanvasElement).RRNodeType) {
            (node as unknown as RRCanvasElement).rr_dataURL = value.toString();
          } else if (canvasNodeIdsToSkip?.has(n.id)) {
            // This canvas has pending mutations that will update it to the correct state.
            // Skip drawing the full snapshot's canvas image to avoid flicker from showing
            // the old snapshot state briefly before the mutation applies.
            // Still preload the image for cache so it's ready if needed later.
            getCachedCanvasImage(value.toString());
          } else {
            // For real DOM canvas, use cached image to avoid flicker when seeking
            const canvas = node as HTMLCanvasElement;
            const ctx = canvas.getContext('2d');
            if (ctx) {
              const dataURL = value.toString();
              const image = getCachedCanvasImage(dataURL);

              if (image.complete && image.naturalWidth > 0) {
                // Image is already loaded (cached), draw immediately - no flicker!
                ctx.drawImage(image, 0, 0, image.width, image.height);
              } else {
                // Image is still loading (first time), set up onload handler
                // This will still flicker on first play, but not on subsequent seeks
                image.onload = () => {
                  // Verify the cached image hasn't been replaced
                  if (canvasDataURLImageCache.get(dataURL) === image) {
                    ctx.drawImage(image, 0, 0, image.width, image.height);
                  }
                };
              }
            }
          }
        } else if (tagName === 'img' && name === 'rr_dataURL') {
          const image = node as HTMLImageElement;
          if (!image.currentSrc.startsWith('data:')) {
            // Backup original img src. It may not have been set yet.
            image.setAttribute(
              'rrweb-original-src',
              n.attributes.src as string,
            );
            image.src = value.toString();
          }
        }

        if (name === 'rr_width') {
          (node as HTMLElement).style.setProperty('width', value.toString());
        } else if (name === 'rr_height') {
          (node as HTMLElement).style.setProperty('height', value.toString());
        } else if (
          name === 'rr_mediaCurrentTime' &&
          typeof value === 'number'
        ) {
          (node as HTMLMediaElement).currentTime = value;
        } else if (name === 'rr_mediaState') {
          switch (value) {
            case 'played':
              (node as HTMLMediaElement)
                .play()
                .catch((e) => console.warn('media playback error', e));
              break;
            case 'paused':
              (node as HTMLMediaElement).pause();
              break;
            default:
          }
        } else if (
          name === 'rr_mediaPlaybackRate' &&
          typeof value === 'number'
        ) {
          (node as HTMLMediaElement).playbackRate = value;
        } else if (name === 'rr_mediaMuted' && typeof value === 'boolean') {
          (node as HTMLMediaElement).muted = value;
        } else if (name === 'rr_mediaLoop' && typeof value === 'boolean') {
          (node as HTMLMediaElement).loop = value;
        } else if (name === 'rr_mediaVolume' && typeof value === 'number') {
          (node as HTMLMediaElement).volume = value;
        } else if (name === 'rr_open_mode') {
          (node as HTMLDialogElement).setAttribute(
            'rr_open_mode',
            value as string,
          ); // keep this attribute for rrweb to trigger showModal
        }
      }

      if (n.isShadowHost) {
        /**
         * Since node is newly rebuilt, it should be a normal element
         * without shadowRoot.
         * But if there are some weird situations that has defined
         * custom element in the scope before we rebuild node, it may
         * register the shadowRoot earlier.
         * The logic in the 'else' block is just a try-my-best solution
         * for the corner case, please let we know if it is wrong and
         * we can remove it.
         */
        if (!node.shadowRoot) {
          node.attachShadow({ mode: 'open' });
        } else {
          while (node.shadowRoot.firstChild) {
            node.shadowRoot.removeChild(node.shadowRoot.firstChild);
          }
        }
      }
      return node;
    }
    case NodeType.Text:
      if (n.isStyle && hackCss) {
        // support legacy style
        return doc.createTextNode(adaptCssForReplay(n.textContent, cache));
      }
      return doc.createTextNode(n.textContent);
    case NodeType.CDATA:
      return doc.createCDATASection(n.textContent);
    case NodeType.Comment:
      return doc.createComment(n.textContent);
    default:
      return null;
  }
}

export function buildNodeWithSN(
  n: serializedNodeWithId,
  options: {
    doc: Document;
    mirror: Mirror;
    skipChild?: boolean;
    hackCss: boolean;
    lazyLoadImages?: boolean;
    /**
     * This callback will be called for each of this nodes' `.childNodes` after they are appended to _this_ node.
     * Caveat: This callback _doesn't_ get called when this node is appended to the DOM.
     */
    afterAppend?: (n: Node, id: number) => unknown;
    cache: BuildCache;
    /**
     * Set of canvas node IDs that have pending mutations.
     * For these canvases, skip drawing rr_dataURL during rebuild because
     * a canvas mutation will update them to the correct state.
     * Canvases NOT in this set will still draw their rr_dataURL.
     */
    canvasNodeIdsToSkip?: Set<number>;
  },
): Node | null {
  const {
    doc,
    mirror,
    skipChild = false,
    hackCss = true,
    lazyLoadImages = false,
    afterAppend,
    cache,
    canvasNodeIdsToSkip,
  } = options;
  /**
   * Add a check to see if the node is already in the mirror. If it is, we can skip the whole process.
   * This situation (duplicated nodes) can happen when recorder has some unfixed bugs and the same node is recorded twice. Or something goes wrong when saving or transferring event data.
   * Duplicated node creation may cause unexpected errors in replayer. This check tries best effort to prevent the errors.
   */
  if (mirror.has(n.id)) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const nodeInMirror = mirror.getNode(n.id)!;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const meta = mirror.getMeta(nodeInMirror)!;
    // For safety concern, check if the node in mirror is the same as the node we are trying to build
    if (isNodeMetaEqual(meta, n)) return mirror.getNode(n.id);
  }
  let node = buildNode(n, {
    doc,
    hackCss,
    cache,
    lazyLoadImages,
    canvasNodeIdsToSkip,
  });
  if (!node) {
    return null;
  }
  // If the snapshot is created by checkout, the rootId doesn't change but the iframe's document can be changed automatically when a new iframe element is created.
  if (n.rootId && (mirror.getNode(n.rootId) as Document) !== doc) {
    mirror.replace(n.rootId, doc);
  }
  // use target document as root document
  if (n.type === NodeType.Document) {
    // close before open to make sure document was closed
    doc.close();
    doc.open();
    if (
      n.compatMode === 'BackCompat' &&
      n.childNodes &&
      n.childNodes[0].type !== NodeType.DocumentType // there isn't one already defined
    ) {
      // Trigger compatMode in the iframe
      // this is needed as document.createElement('iframe') otherwise inherits a CSS1Compat mode from the parent replayer environment
      if (
        n.childNodes[0].type === NodeType.Element &&
        'xmlns' in n.childNodes[0].attributes &&
        n.childNodes[0].attributes.xmlns === 'http://www.w3.org/1999/xhtml'
      ) {
        // might as well use an xhtml doctype if we've got an xhtml namespace
        doc.write(
          '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "">',
        );
      } else {
        doc.write(
          '<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.0 Transitional//EN" "">',
        );
      }
    }
    node = doc;
  }

  mirror.add(node, n);

  if (
    (n.type === NodeType.Document || n.type === NodeType.Element) &&
    !skipChild
  ) {
    for (const childN of n.childNodes) {
      const childNode = buildNodeWithSN(childN, {
        doc,
        mirror,
        skipChild: false,
        hackCss,
        lazyLoadImages,
        afterAppend,
        cache,
        canvasNodeIdsToSkip,
      });
      if (!childNode) {
        console.warn('Failed to rebuild', childN);
        continue;
      }

      if (childN.isShadow && isElement(node) && node.shadowRoot) {
        node.shadowRoot.appendChild(childNode);
      } else if (
        n.type === NodeType.Document &&
        childN.type == NodeType.Element
      ) {
        const htmlElement = childNode as HTMLElement;
        let body: HTMLBodyElement | null = null;
        htmlElement.childNodes.forEach((child) => {
          if (child.nodeName === 'BODY') body = child as HTMLBodyElement;
        });
        if (body) {
          // this branch solves a problem in Firefox where css transitions are incorrectly
          // being applied upon rebuild.  Presumably FF doesn't finished parsing the styles
          // in time, and applies e.g. a default margin:0 to elements which have a non-zero
          // margin set in CSS, along with a transition on them
          htmlElement.removeChild(body);
          // append <head> and <style>s
          node.appendChild(childNode);
          // now append <body>
          htmlElement.appendChild(body);
        } else {
          node.appendChild(childNode);
        }
      } else {
        node.appendChild(childNode);
      }
      if (afterAppend) {
        afterAppend(childNode, childN.id);
      }
    }
  }

  return node;
}

function visit(mirror: Mirror, onVisit: (node: Node) => void) {
  function walk(node: Node) {
    onVisit(node);
  }

  for (const id of mirror.getIds()) {
    if (mirror.has(id)) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      walk(mirror.getNode(id)!);
    }
  }
}

function handleScroll(node: Node, mirror: Mirror) {
  const n = mirror.getMeta(node);
  if (n?.type !== NodeType.Element) {
    return;
  }
  const el = node as HTMLElement;
  for (const name in n.attributes) {
    if (
      !(
        Object.prototype.hasOwnProperty.call(n.attributes, name) &&
        name.startsWith('rr_')
      )
    ) {
      continue;
    }
    const value = n.attributes[name];
    if (name === 'rr_scrollLeft') {
      el.scrollLeft = value as number;
    }
    if (name === 'rr_scrollTop') {
      el.scrollTop = value as number;
    }
  }
}

function rebuild(
  n: serializedNodeWithId,
  options: {
    doc: Document;
    onVisit?: (node: Node) => unknown;
    hackCss?: boolean;
    lazyLoadImages?: boolean;
    afterAppend?: (n: Node, id: number) => unknown;
    cache: BuildCache;
    mirror: Mirror;
    /**
     * Set of canvas node IDs that have pending mutations.
     * For these canvases, skip drawing rr_dataURL during rebuild because
     * a canvas mutation will update them to the correct state.
     * Canvases NOT in this set will still draw their rr_dataURL.
     */
    canvasNodeIdsToSkip?: Set<number>;
  },
): Node | null {
  const {
    doc,
    onVisit,
    hackCss = true,
    lazyLoadImages = false,
    afterAppend,
    cache,
    mirror = new Mirror(),
    canvasNodeIdsToSkip,
  } = options;
  const node = buildNodeWithSN(n, {
    doc,
    mirror,
    skipChild: false,
    hackCss,
    lazyLoadImages,
    afterAppend,
    cache,
    canvasNodeIdsToSkip,
  });
  visit(mirror, (visitedNode) => {
    if (onVisit) {
      onVisit(visitedNode);
    }
    handleScroll(visitedNode, mirror);
  });
  return node;
}

export default rebuild;
