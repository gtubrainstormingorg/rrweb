import type { MutationBufferParam } from '../types';
import type {
  mutationCallBack,
  scrollCallback,
  SamplingStrategy,
} from '@howdygo/rrweb-types';
import {
  initMutationObserver,
  initScrollObserver,
  initAdoptedStyleSheetObserver,
} from './observer';
import { patch, inDom } from '../utils';
import type { Mirror } from '@howdygo/rrweb-snapshot';
import { isNativeShadowDom } from '@howdygo/rrweb-snapshot';
import dom from '@howdygo/rrweb-utils';

type BypassOptions = Omit<
  MutationBufferParam,
  'doc' | 'mutationCb' | 'mirror' | 'shadowDomManager'
> & {
  sampling: SamplingStrategy;
};

export class ShadowDomManager {
  private shadowDoms = new WeakSet<ShadowRoot>();
  private mutationCb: mutationCallBack;
  private scrollCb: scrollCallback;
  private bypassOptions: BypassOptions;
  private mirror: Mirror;
  private restoreHandlers: (() => void)[] = [];

  constructor(options: {
    mutationCb: mutationCallBack;
    scrollCb: scrollCallback;
    bypassOptions: BypassOptions;
    mirror: Mirror;
  }) {
    this.mutationCb = options.mutationCb;
    this.scrollCb = options.scrollCb;
    this.bypassOptions = options.bypassOptions;
    this.mirror = options.mirror;

    this.init();
  }

  public init() {
    this.reset();
    // Patch 'attachShadow' to observe newly added shadow doms.
    this.patchAttachShadow(Element, document);
  }

  public addShadowRoot(shadowRoot: ShadowRoot, doc: Document) {
    if (!isNativeShadowDom(shadowRoot)) return;
    if (this.shadowDoms.has(shadowRoot)) {
      // Shadow root was registered earlier. This call originates from
      // mutation onSerialize, which fires while the mutation is still being
      // built — the mutation event hasn't been emitted yet. Deferring via
      // setTimeout(0) ensures the AdoptedStyleSheet event lands AFTER the
      // mutation event in the stream. Otherwise, when the move/re-add
      // mutation is applied on replay, it would destroy the prior shadow
      // root (along with its adopted stylesheets) AFTER the AdoptedStyleSheet
      // event already applied — leaving the new shadow root empty.
      //
      // Frameworks like Stencil (Ionic) set adoptedStyleSheets synchronously
      // inside connectedCallback before the host is mirrored, and Ionic
      // reparents ion-modal elements between locations during open/close —
      // each move triggers a remove+add mutation that wipes the host's
      // shadow root on replay. See HWG-844.
      setTimeout(() => this.captureAdoptedStyleSheets(shadowRoot), 0);
      return;
    }
    this.shadowDoms.add(shadowRoot);
    this.bypassOptions.canvasManager.addShadowRoot(shadowRoot);
    const observer = initMutationObserver(
      {
        ...this.bypassOptions,
        doc,
        mutationCb: this.mutationCb,
        mirror: this.mirror,
        shadowDomManager: this,
      },
      shadowRoot,
    );
    this.restoreHandlers.push(() => observer.disconnect());
    this.restoreHandlers.push(
      initScrollObserver({
        ...this.bypassOptions,
        scrollCb: this.scrollCb,
        // https://gist.github.com/praveenpuglia/0832da687ed5a5d7a0907046c9ef1813
        // scroll is not allowed to pass the boundary, so we need to listen the shadow document
        doc: shadowRoot as unknown as Document,
        mirror: this.mirror,
      }),
    );
    // Defer this to avoid adoptedStyleSheet events being created before the full snapshot is created or attachShadow action is recorded.
    setTimeout(() => {
      this.captureAdoptedStyleSheets(shadowRoot);
      this.restoreHandlers.push(
        initAdoptedStyleSheetObserver(
          {
            mirror: this.mirror,
            stylesheetManager: this.bypassOptions.stylesheetManager,
          },
          shadowRoot,
        ),
      );
    }, 0);
  }

  private captureAdoptedStyleSheets(shadowRoot: ShadowRoot) {
    if (
      !shadowRoot.adoptedStyleSheets ||
      shadowRoot.adoptedStyleSheets.length === 0
    )
      return;
    const hostId = this.mirror.getId(dom.host(shadowRoot));
    if (hostId === -1) return;
    this.bypassOptions.stylesheetManager.adoptStyleSheets(
      shadowRoot.adoptedStyleSheets,
      hostId,
    );
  }

  /**
   * Monkey patch 'attachShadow' of an IFrameElement to observe newly added shadow doms.
   */
  public observeAttachShadow(iframeElement: HTMLIFrameElement) {
    if (!iframeElement.contentWindow || !iframeElement.contentDocument) return;

    this.patchAttachShadow(
      (
        iframeElement.contentWindow as Window & {
          Element: { prototype: Element };
        }
      ).Element,
      iframeElement.contentDocument,
    );
  }

  /**
   * Patch 'attachShadow' to observe newly added shadow doms.
   */
  private patchAttachShadow(
    element: {
      prototype: Element;
    },
    doc: Document,
  ) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const manager = this;
    this.restoreHandlers.push(
      patch(
        element.prototype,
        'attachShadow',
        function (original: (init: ShadowRootInit) => ShadowRoot) {
          return function (this: Element, option: ShadowRootInit) {
            const sRoot = original.call(this, option);
            // For the shadow dom elements in the document, monitor their dom mutations.
            // For shadow dom elements that aren't in the document yet,
            // we start monitoring them once their shadow dom host is appended to the document.
            const shadowRootEl = dom.shadowRoot(this);
            if (shadowRootEl && inDom(this))
              manager.addShadowRoot(shadowRootEl, doc);
            return sRoot;
          };
        },
      ),
    );
  }

  public reset() {
    this.restoreHandlers.forEach((handler) => {
      try {
        handler();
      } catch (e) {
        //
      }
    });
    this.restoreHandlers = [];
    this.shadowDoms = new WeakSet();
    this.bypassOptions.canvasManager.resetShadowRoots();
  }
}
