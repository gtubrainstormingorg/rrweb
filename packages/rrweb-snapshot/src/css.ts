import type { AcceptedPlugin, Rule } from 'postcss';

const MEDIA_SELECTOR = /(max|min)-device-(width|height)/;
const MEDIA_SELECTOR_GLOBAL = new RegExp(MEDIA_SELECTOR.source, 'g');

const mediaSelectorPlugin: AcceptedPlugin = {
  postcssPlugin: 'postcss-custom-selectors',
  prepare() {
    return {
      postcssPlugin: 'postcss-custom-selectors',
      AtRule: function (atrule) {
        if (atrule.params.match(MEDIA_SELECTOR_GLOBAL)) {
          atrule.params = atrule.params.replace(MEDIA_SELECTOR_GLOBAL, '$1-$2');
        }
      },
    };
  },
};

// Simplified from https://github.com/giuseppeg/postcss-pseudo-classes/blob/master/index.js
const pseudoClassPlugin: AcceptedPlugin = {
  postcssPlugin: 'postcss-hover-classes',
  prepare: function () {
    const fixed: Rule[] = [];
    return {
      Rule: function (rule) {
        if (fixed.indexOf(rule) !== -1) {
          return;
        }
        fixed.push(rule);
        rule.selectors.forEach(function (selector) {
          if (selector.includes(':hover')) {
            rule.selector += ',\n' + selector.replace(/:hover/g, '.\\:hover');
          }
        });
      },
    };
  },
};

function fixCssBracketsAtRule(cssString: string): string {
  // Regular expression to find any `@` rule (e.g., @font-face, @media, @keyframes)
  const atRuleRegex = /@[\w-]+\s*[^{;]*{/g;

  let match: RegExpExecArray | null;

  // Loop through all `@` rules in the CSS
  while ((match = atRuleRegex.exec(cssString)) !== null) {
    // Extract the substring before the current `@` rule
    const cssBeforeAtRule = cssString.substring(0, match.index);

    // Check if there are unbalanced braces using a simple count
    let openBracesCount = 0;
    for (let char of cssBeforeAtRule) {
      if (char === '{') openBracesCount++;
      if (char === '}') openBracesCount--;
    }

    // If there are more opening braces than closing braces, we need to close the block
    if (openBracesCount > 0) {
      // Find the point to insert the closing braces: directly before the `@` rule
      let insertionPoint = match.index;

      // Move the insertion point back to just after the last semicolon or closing brace
      while (insertionPoint > 0 && /\s|;/.test(cssString[insertionPoint - 1])) {
        insertionPoint--;
      }

      // Prepare the string to insert the necessary number of closing braces
      const closingBraces = ' }'.repeat(openBracesCount);

      // Insert the closing braces at the calculated insertion point
      cssString = `${cssString.substring(
        0,
        insertionPoint,
      )}${closingBraces}${cssString.substring(insertionPoint)}`;
    }
  }

  return cssString;
}

export { mediaSelectorPlugin, pseudoClassPlugin, fixCssBracketsAtRule };
